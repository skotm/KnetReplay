/**
 * app.js
 * ------------------------------------------------------------
 * ブラウザ側のオーケストレーション(ストリーミング方式)。
 *
 * 大規模データ(数百観測点・長時間記録、345MB超のzip等)でも処理落ちしない
 * よう、以下の設計にしている:
 *  - zipエントリを1件ずつ展開→パースし、3成分が揃った観測点は「その場で
 *    即座にWorkerへディスパッチして処理を開始」する(全観測点を読み終える
 *    まで待たない)。処理済みの観測点データはメモリから即座に解放する
 *  - 生の加速度データはFloat64Array(typed array)で保持し、Workerへの
 *    postMessageもtransferable(ゼロコピー転送)で行う。これにより
 *    メインスレッド↔Worker間のコピーコストとメモリ使用量を大幅に削減する
 *  - 重い計算(FFTフィルタ)は引き続きWeb Worker上で実行し、UIの応答性を保つ
 */
import { parseKnetAscii } from "./knetAsciiParser.js";
import { normalizeDirection } from "./knetDirection.js";
import { encodeIntensityDelta, diffIntensityMaps } from "./protocolEncode.js";
import { loadKmoniObsPointsByCode } from "./kmoniObsPoints.js";
import { decodeReplay, checkOverlap, mergeReplays } from "./replayMerge.js";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

const $ = (id) => document.getElementById(id);

let obsPointsByCode = null;

async function loadObsPoints() {
  const res = await fetch("./intensity-points.json");
  const raw = await res.json();
  obsPointsByCode = loadKmoniObsPointsByCode(raw);
}

function parseJstDateTime(str) {
  const iso = str.replace(/\//g, "-").replace(" ", "T") + "+09:00";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`日時の形式が不正です: "${str}"`);
  return d;
}

function looksLikeIrrelevantEntry(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith("/")) return true;
  if (lower.endsWith(".txt") || lower.endsWith(".ch") || lower.endsWith(".pdf")) return true;
  return false;
}

function log(msg) {
  const el = $("log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

function setProgress(pct) {
  $("progressBar").style.width = `${pct}%`;
}

/* ─────────────────────────────────────────────
   Web Workerプール
   ───────────────────────────────────────────── */
const WORKER_POOL_SIZE = Math.min(4, navigator.hardwareConcurrency || 2);

class WorkerPool {
  constructor(size) {
    this.workers = Array.from({ length: size }, () => new Worker("./intensityWorker.js", { type: "module" }));
    this.freeWorkers = [...this.workers];
    this.queue = [];
    this.pending = new Map();
    this.nextRequestId = 1;
    for (const w of this.workers) {
      w.onmessage = (ev) => this._handleMessage(w, ev.data);
    }
  }
  _handleMessage(worker, msg) {
    const entry = this.pending.get(msg.requestId);
    this.pending.delete(msg.requestId);
    this.freeWorkers.push(worker);
    this._dequeue();
    if (!entry) return;
    if (msg.type === "result") entry.resolve(msg);
    else entry.resolve({ type: "error", message: msg.message });
  }
  _dequeue() {
    if (this.freeWorkers.length === 0 || this.queue.length === 0) return;
    const worker = this.freeWorkers.pop();
    const { payload, transfer, resolve } = this.queue.shift();
    const requestId = this.nextRequestId++;
    this.pending.set(requestId, { resolve });
    worker.postMessage({ ...payload, type: "process", requestId }, transfer);
  }
  /** payload内のFloat64Array(ns/ew/ud)はtransferable転送で渡す(ゼロコピー、メインスレッド側は以後使用不可になる) */
  process(payload) {
    const transfer = [payload.ns.buffer, payload.ew.buffer, payload.ud.buffer];
    return new Promise((resolve) => {
      this.queue.push({ payload, transfer, resolve });
      this._dequeue();
    });
  }
  terminate() {
    for (const w of this.workers) w.terminate();
  }
}

/* ─────────────────────────────────────────────
   メイン処理: ストリーミング方式
   ───────────────────────────────────────────── */
async function processAll(files, windowSec, stepSec, filterType) {
  $("log").textContent = "";
  setProgress(0);
  $("downloadBtn").style.display = "none";

  if (!obsPointsByCode) await loadObsPoints();

  const pool = new WorkerPool(WORKER_POOL_SIZE);

  // 3成分が揃うまでの一時的な保持(観測点コードごと)。揃った時点で即座に
  // Workerへディスパッチし、このMapからは削除してメモリを解放する。
  const pendingGroups = new Map(); // stationCode -> { NS, EW, UD }
  const dispatchedPromises = []; // 各観測点のWorker処理Promise(結果は後でまとめて回収)
  let firstHeader = null;
  let dispatchedCount = 0;
  let skippedCount = 0;
  let skippedBoreholeCount = 0; // KiK-netの地中(ch1〜3)のファイル数
  let kiknetSurfaceFileCount = 0; // KiK-netの地表(ch4〜6)のファイル数

  function tryDispatch(code) {
    const comp = pendingGroups.get(code);
    if (!comp.NS || !comp.EW || !comp.UD) return; // まだ3成分揃っていない

    pendingGroups.delete(code); // メモリ解放(以後この観測点の生データはWorker側にのみ存在)

    const sampleRateHz = comp.NS.header.samplingFreqHz;
    if (comp.EW.header.samplingFreqHz !== sampleRateHz || comp.UD.header.samplingFreqHz !== sampleRateHz) {
      log(`✗ ${code}: 3成分のサンプリング周波数が一致しません`);
      skippedCount++;
      return;
    }
    const obsPoint = obsPointsByCode.get(code);
    if (!obsPoint) {
      log(`✗ ${code}: MeteoQuakeの既知観測点リストに見つかりません(スキップ)`);
      skippedCount++;
      return;
    }
    if (!firstHeader) firstHeader = comp.NS.header;

    const recordStart = parseJstDateTime(comp.NS.header.recordTime);
    dispatchedCount++;

    const promise = pool
      .process({
        stationCode: code,
        obsId: obsPoint.id,
        ns: comp.NS.accelerationGal,
        ew: comp.EW.accelerationGal,
        ud: comp.UD.accelerationGal,
        sampleRateHz,
        recordTimeMs: recordStart.getTime(),
        windowSec,
        stepSec,
        filterType,
      })
      .then((res) => {
        if (res.type === "error") {
          log(`✗ ${code}: 処理エラー (${res.message})`);
          return null;
        }
        log(`✓ ${code}: id=${obsPoint.id} フレーム数=${res.series.length}`);
        return { obsId: obsPoint.id, series: res.series };
      });

    dispatchedPromises.push(promise);
  }

  async function handleOneEntry(name, getTextFn) {
    if (looksLikeIrrelevantEntry(name)) return;

    let text;
    try {
      text = await getTextFn();
    } catch (e) {
      log(`✗ ${name}: 読み込み失敗 (${e.message})`);
      return;
    }

    let parsed;
    try {
      parsed = parseKnetAscii(text);
    } catch {
      return; // K-NET ASCIIとして解釈できないファイルは静かにスキップ
    }
    text = null;

    const dirInfo = normalizeDirection(parsed.header.direction, name);
    if (!dirInfo) {
      log(`✗ ${name}: 方向(Dir.)を認識できません ("${parsed.header.direction}")`);
      return;
    }
    if (dirInfo.placement === "borehole") {
      // KiK-netの地中(ch1〜3)は使わない。地表(ch4〜6)だけで計算する
      skippedBoreholeCount++;
      return;
    }
    if (dirInfo.channel !== null) kiknetSurfaceFileCount++;

    const code = parsed.header.stationCode;
    if (!pendingGroups.has(code)) pendingGroups.set(code, {});
    pendingGroups.get(code)[dirInfo.axis] = parsed;
    tryDispatch(code);
  }

  let fileCounter = 0;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      log(`zipを展開中: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
      const zip = await JSZip.loadAsync(file);
      const zipEntries = Object.values(zip.files).filter((f) => !f.dir);
      log(`  ${zipEntries.length}件のエントリを検出。順次処理します...`);

      let processedInZip = 0;
      for (const zf of zipEntries) {
        await handleOneEntry(zf.name.split("/").pop(), () => zf.async("text"));
        processedInZip++;
        fileCounter++;
        if (fileCounter % 20 === 0) {
          await new Promise((r) => setTimeout(r, 0)); // イベントループへ制御を返す
          setProgress(Math.min(70, Math.round((processedInZip / zipEntries.length) * 70)));
        }
        if (processedInZip % 100 === 0) {
          log(`  ...${processedInZip}/${zipEntries.length}件処理済み(うち${dispatchedCount}観測点をWorkerへディスパッチ済み)`);
        }
      }
      log(`  ${file.name} の展開・ディスパッチが完了`);
    } else {
      fileCounter++;
      await handleOneEntry(file.name, () => file.text());
      if (fileCounter % 20 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  if (pendingGroups.size > 0) {
    for (const code of [...pendingGroups.keys()]) {
      const missing = ["NS", "EW", "UD"].filter((d) => !pendingGroups.get(code)[d]);
      log(`✗ ${code}: 3成分が揃いませんでした(不足: ${missing.join(", ")})`);
      skippedCount++;
    }
  }

  if (skippedBoreholeCount > 0 || kiknetSurfaceFileCount > 0) {
    log(`\nKiK-net: 地表(ch4〜6)${kiknetSurfaceFileCount}ファイルを使用、地中(ch1〜3)${skippedBoreholeCount}ファイルは使用しません`);
  }
  log(`\n${dispatchedCount}観測点をWorker(${WORKER_POOL_SIZE}並列)へディスパッチしました。処理完了を待っています...`);
  log(`使用フィルタ: ${filterType === "kunugi2012" ? "2012フィルタ(強震モニタ相当)" : "気象庁フィルタ(FFTベース厳密)"}`);
  setProgress(75);

  const results = await Promise.all(dispatchedPromises);
  pool.terminate();

  const stations = results.filter(Boolean);
  if (stations.length === 0) {
    log("\n有効な観測点データがありませんでした(または全てエラー)。処理を中止します。");
    return null;
  }

  setProgress(85);

  // 全観測点の全時刻を統合タイムラインにする
  const allTimestampsMs = new Set();
  for (const st of stations) {
    for (const pt of st.series) {
      const roundedMs = Math.round(pt.timeMs / (stepSec * 1000)) * (stepSec * 1000);
      allTimestampsMs.add(roundedMs);
    }
  }
  const sortedTimestamps = [...allTimestampsMs].sort((a, b) => a - b);

  const valueByStationAndTime = new Map();
  for (const st of stations) {
    const m = new Map();
    for (const pt of st.series) {
      const roundedMs = Math.round(pt.timeMs / (stepSec * 1000)) * (stepSec * 1000);
      m.set(roundedMs, pt.intensity);
    }
    valueByStationAndTime.set(st.obsId, m);
  }

  const frames = [];
  let previousValues = new Map();
  let hasBaseline = false;

  for (const ts of sortedTimestamps) {
    const currentValues = new Map();
    for (const st of stations) {
      const v = valueByStationAndTime.get(st.obsId).get(ts);
      if (v !== undefined) currentValues.set(st.obsId, v);
    }

    const time = new Date(ts);
    if (!hasBaseline) {
      const baseline = [...currentValues.entries()].map(([id, intensity]) => ({ id, intensity }));
      frames.push(new Uint8Array(encodeIntensityDelta(time, baseline)));
      hasBaseline = true;
    } else {
      const diff = diffIntensityMaps(previousValues, currentValues);
      if (diff.length > 0) {
        frames.push(new Uint8Array(encodeIntensityDelta(time, diff)));
      }
    }
    previousValues = currentValues;
  }

  setProgress(95);

  const totalLength = frames.reduce((sum, f) => sum + f.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const f of frames) {
    merged.set(f, offset);
    offset += f.byteLength;
  }

  setProgress(100);
  log(`\n完了: ${stations.length}観測点(スキップ${skippedCount}件), ${frames.length}フレーム, ${merged.byteLength}バイト`);

  return { blob: new Blob([merged], { type: "application/octet-stream" }), header: firstHeader, stationCount: stations.length };
}

/* ─────────────────────────────────────────────
   リプレイファイル結合モード
   ───────────────────────────────────────────── */
function formatJst(unixSec) {
  const d = new Date((unixSec + 9 * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function processMerge(files, conflict, gapFill) {
  $("log").textContent = "";
  setProgress(0);
  $("downloadBtn").style.display = "none";

  if (files.length < 2) {
    log("結合するには2つ以上のリプレイファイル(.bin)を選択してください。");
    return null;
  }

  const decoded = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const d = decodeReplay(await file.arrayBuffer());
      decoded.push({ ...d, name: file.name });
      log(`✓ ${file.name}: ${d.frames.length}フレーム  ${formatJst(d.firstTs)} 〜 ${formatJst(d.lastTs)} (JST)`);
    } catch (e) {
      log(`✗ ${file.name}: 読み込み失敗 (${e.message})`);
      log("\n読み込めないファイルがあるため中止しました。");
      return null;
    }
    setProgress(Math.round(((i + 1) / files.length) * 40));
  }

  const overlap = checkOverlap(decoded);
  if (!overlap.connected) {
    log("\n✗ 時刻に共通部分が無いファイルがあるため結合できません。重ならないグループ:");
    overlap.groups.forEach((g, gi) => {
      log(`  グループ${gi + 1}: ${g.map((i) => decoded[i].name).join(", ")}`);
    });
    return null;
  }

  setProgress(60);
  await new Promise((r) => setTimeout(r, 0)); // 進捗表示を更新させる
  const { bytes, info } = mergeReplays(decoded, { conflict, gapFill });
  setProgress(100);

  log(`\n結合完了: ${decoded.length}ファイル → ${info.frameCount}フレーム, ${info.stationCount}観測点, ${bytes.byteLength}バイト`);
  log(`時刻範囲: ${formatJst(info.firstTs)} 〜 ${formatJst(info.lastTs)} (JST)`);
  if (info.conflictCount > 0) {
    log(`同一観測点の重複: ${info.conflictCount}件(${conflict === "max" ? "最大値を採用" : "最も早いファイルの値を採用"})`);
  } else {
    log("同一観測点の重複: なし");
  }
  const rp = info.reappear;
  if (rp.stationCount > 0) {
    log(`再出現する観測点: ${rp.stationCount}観測点(ファイルの切り替わりで一度消え、次の記録開始で再び現れる。空白は最長${rp.longestSec}秒)`);
  } else {
    log("再出現する観測点: なし(ファイルをまたいで途切れる観測点はありません)");
  }
  const gf = info.gapFill;
  if (gf.method === "none") {
    log("ファイル間の空白の補間: しない");
  } else if (gf.gapCount === 0) {
    log(`ファイル間の空白の補間: 対象なし(${gf.maxSec}秒以下の空白は見つかりませんでした)`);
  } else {
    log(`ファイル間の空白の補間(${gf.method === "linear" ? "直線補間" : "直前の値を保持"}): ${gf.stationCount}観測点・${gf.gapCount}区間(最長${gf.longestSec}秒)、補間値${gf.filledSamples}点`);
  }

  return {
    blob: new Blob([bytes], { type: "application/octet-stream" }),
    fileNameBase: `${formatJst(info.firstTs).slice(0, 10).replace(/\//g, "")}_knet_merged`,
  };
}

function suggestFileName(header) {
  if (!header || !header.originTime) return "replay";
  const originJst = parseJstDateTime(header.originTime);
  const jstShifted = new Date(originJst.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${jstShifted.getUTCFullYear()}${pad(jstShifted.getUTCMonth() + 1)}${pad(jstShifted.getUTCDate())}`;
  const magText = header.magnitude ? `M${header.magnitude}` : "";
  return `${dateStr}_knet${magText}`;
}

let lastResult = null;

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function applyMode() {
  const merge = currentMode() === "merge";
  $("modeNote").style.display = merge ? "block" : "none";
  $("convertParams").style.display = merge ? "none" : "block";
  $("mergeParams").style.display = merge ? "block" : "none";
  $("convertNote").style.display = merge ? "none" : "block";
  $("processBtn").textContent = merge ? "結合開始" : "変換開始";
  $("dropZoneText").innerHTML = merge
    ? "ここに結合したいリプレイファイル(.bin)を2つ以上<br>ドラッグ&ドロップ、またはクリックして選択"
    : "ここにNIEDからダウンロードしたzip、またはK-NET ASCIIファイルを<br>ドラッグ&ドロップ、またはクリックして選択";
  $("fileInput").accept = merge ? ".bin,*" : ".zip,*";
  // モードをまたいで前回の選択・結果を持ち越さない
  $("fileInput").value = "";
  $("fileCount").textContent = "";
  $("log").textContent = "";
  $("downloadBtn").style.display = "none";
  $("fileName").value = "";
  setProgress(0);
  lastResult = null;
}

document.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", applyMode));
applyMode(); // ブラウザのリロード時にラジオボタン状態が復元されても表示を合わせる

$("processBtn").addEventListener("click", async () => {
  const files = $("fileInput").files;
  const merge = currentMode() === "merge";
  if (!files || files.length === 0) {
    alert(merge ? "結合するリプレイファイル(.bin)を選択してください" : "K-NET ASCIIファイル(またはzip)を選択してください");
    return;
  }

  $("processBtn").disabled = true;
  try {
    if (merge) {
      lastResult = await processMerge([...files], $("conflictMode").value, {
        method: $("gapMode").value,
        maxSec: Number($("gapMaxSec").value) || 60,
      });
      if (lastResult) $("fileName").value = lastResult.fileNameBase;
    } else {
      const windowSec = Number($("windowSec").value) || 10;
      const stepSec = Number($("stepSec").value) || 1;
      const filterType = $("filterType").value;
      lastResult = await processAll(files, windowSec, stepSec, filterType);
      if (lastResult) $("fileName").value = suggestFileName(lastResult.header);
    }
    if (lastResult) $("downloadBtn").style.display = "inline-block";
  } catch (e) {
    log(`\nエラー: ${e.message}`);
  } finally {
    $("processBtn").disabled = false;
  }
});

$("downloadBtn").addEventListener("click", () => {
  if (!lastResult) return;
  const fileNameBase = ($("fileName").value.trim() || "replay").replace(/[\\/:*?"<>|]/g, "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(lastResult.blob);
  a.download = `${fileNameBase}.bin`;
  document.body.appendChild(a);
  a.click();
  a.remove();
});

// ドラッグ&ドロップ対応
const dropZone = $("dropZone");
dropZone.addEventListener("click", () => $("fileInput").click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  $("fileInput").files = e.dataTransfer.files;
  $("fileCount").textContent = `${e.dataTransfer.files.length}件選択中`;
});
$("fileInput").addEventListener("change", () => {
  $("fileCount").textContent = `${$("fileInput").files.length}件選択中`;
});
