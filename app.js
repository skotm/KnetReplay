/**
 * app.js
 * ------------------------------------------------------------
 * ブラウザ側のオーケストレーション。
 *  1. zip(またはファイル群)を1件ずつ展開・パースし、観測点コード+方向で
 *     グループ化する(展開後のテキストを全件同時にメモリへ保持しない)
 *  2. NS/EW/UDが揃った観測点ごとに、Web Worker上でJMAフィルタ→震度時系列
 *     を計算する(重い計算をメインスレッドから分離し、UIを固まらせない)
 *  3. intensity-points.jsonと突き合わせてid割当
 *  4. 全観測点をタイムライン統合し、リアルタイム配信と同じバイナリ形式で書き出す
 *
 * 大きなzip(100MB超)でも処理落ちしないよう配慮している点:
 *  - zipエントリは1件ずつ展開→パース→即座にヘッダー以外を捨てる、を繰り返す
 *    (全件を同時に展開済みテキストとして保持しない)
 *  - 明らかにK-NETデータではないファイル(.txt/.ch等)は展開前に名前で除外
 *  - 重い計算(FFTフィルタ)はWeb Workerで行い、メインスレッドは常に応答可能
 *  - 定期的にイベントループへ制御を返す(await setTimeout(0))
 */
import { parseKnetAscii } from "./knetAsciiParser.js";
import { encodeIntensityDelta, diffIntensityMaps } from "./protocolEncode.js";
import { loadKmoniObsPointsByCode } from "./kmoniObsPoints.js";
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

/**
 * 方向(Dir.)欄を解釈する。
 * K-NET(表層のみ): "N-S" / "E-W" / "U-D" のような文字列
 * KiK-net(表層+地中ペア): 数値コード 1〜6
 *   1=NS(表層) 2=EW(表層) 3=UD(表層) 4=NS(地中) 5=EW(地中) 6=UD(地中)
 * (実際のNIEDダウンロードデータで確認済みの対応関係)
 *
 * @returns {{axis: "NS"|"EW"|"UD", placement: "surface"|"borehole"} | null}
 */
function normalizeDirection(raw) {
  const trimmed = raw.trim();

  const numericCode = { "1": ["NS", "surface"], "2": ["EW", "surface"], "3": ["UD", "surface"], "4": ["NS", "borehole"], "5": ["EW", "borehole"], "6": ["UD", "borehole"] };
  if (numericCode[trimmed]) {
    const [axis, placement] = numericCode[trimmed];
    return { axis, placement };
  }

  const s = trimmed.toUpperCase().replace(/[-\s]/g, "");
  if (s.includes("NS") || s === "N") return { axis: "NS", placement: "surface" };
  if (s.includes("EW") || s === "E") return { axis: "EW", placement: "surface" };
  if (s.includes("UD") || s.includes("VERT") || s === "U") return { axis: "UD", placement: "surface" };

  return null;
}

/** zipエントリ名から、K-NET ASCIIファイルではないと明らかに分かるものを除外する(展開前フィルタ) */
function looksLikeIrrelevantEntry(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith("/")) return true; // ディレクトリ
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

/**
 * ファイル群(zip含む)を1件ずつ展開・パースし、観測点コード+方向でグループ化する。
 * 展開後のテキストはパース直後に破棄し(パース結果の数値配列だけ保持)、
 * メモリ上に同時に大量のテキストを溜め込まないようにしている。
 */
async function collectStationGroups(files) {
  const groups = new Map(); // stationCode -> { NS, EW, UD }
  let fileCounter = 0;

  async function handleOneEntry(name, getTextFn) {
    if (looksLikeIrrelevantEntry(name)) return;

    fileCounter++;
    if (fileCounter % 20 === 0) {
      // 定期的にイベントループへ制御を返す(UIの応答性・進捗表示更新のため)
      await new Promise((r) => setTimeout(r, 0));
    }

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
      // K-NET ASCIIとして解釈できないファイル(readme等)は静かにスキップ
      return;
    }
    text = null; // 参照を切ってGCしやすくする

    const dirInfo = normalizeDirection(parsed.header.direction);
    if (!dirInfo) {
      log(`✗ ${name}: 方向(Dir.)を認識できません ("${parsed.header.direction}")`);
      return;
    }
    if (dirInfo.placement === "borehole") {
      return; // 地中側は使わない(ログが大量になるため個別出力はしない)
    }

    const code = parsed.header.stationCode;
    if (!groups.has(code)) groups.set(code, {});
    groups.get(code)[dirInfo.axis] = parsed;
  }

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
        if (processedInZip % 50 === 0) {
          log(`  ...${processedInZip}/${zipEntries.length}件処理済み`);
        }
      }
      log(`  ${file.name} の展開・処理が完了`);
    } else {
      await handleOneEntry(file.name, () => file.text());
    }
  }

  return groups;
}

/* ─────────────────────────────────────────────
   Web Workerプール
   複数観測点を並列処理できるよう、少数のWorkerを使い回す
   (多すぎるとメモリ/コンテキストスイッチのコストが増えるため、
   ブラウザのCPUコア数に応じて妥当な数に絞る)。
   ───────────────────────────────────────────── */
const WORKER_POOL_SIZE = Math.min(4, navigator.hardwareConcurrency || 2);

class WorkerPool {
  constructor(size) {
    this.workers = Array.from({ length: size }, () => new Worker("./intensityWorker.js", { type: "module" }));
    this.freeWorkers = [...this.workers];
    this.queue = [];
    this.pending = new Map(); // requestId -> {resolve, reject}
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
    const { payload, resolve } = this.queue.shift();
    const requestId = this.nextRequestId++;
    this.pending.set(requestId, { resolve });
    worker.postMessage({ ...payload, type: "process", requestId });
  }

  process(payload) {
    return new Promise((resolve) => {
      this.queue.push({ payload, resolve });
      this._dequeue();
    });
  }

  terminate() {
    for (const w of this.workers) w.terminate();
  }
}

async function processAll(files, windowSec, stepSec) {
  $("log").textContent = "";
  setProgress(0);
  $("downloadBtn").style.display = "none";

  if (!obsPointsByCode) await loadObsPoints();

  const groups = await collectStationGroups(files);
  log(`\n観測点グループ数: ${groups.size}`);

  const validStations = [];
  for (const [code, comp] of groups) {
    if (!comp.NS || !comp.EW || !comp.UD) {
      const missing = ["NS", "EW", "UD"].filter((d) => !comp[d]);
      log(`✗ ${code}: 3成分が揃っていません(不足: ${missing.join(", ")})`);
      continue;
    }
    const sampleRateHz = comp.NS.header.samplingFreqHz;
    if (comp.EW.header.samplingFreqHz !== sampleRateHz || comp.UD.header.samplingFreqHz !== sampleRateHz) {
      log(`✗ ${code}: 3成分のサンプリング周波数が一致しません`);
      continue;
    }
    const obsPoint = obsPointsByCode.get(code);
    if (!obsPoint) {
      log(`✗ ${code}: MeteoQuakeの既知観測点リストに見つかりません(スキップ)`);
      continue;
    }
    validStations.push({ code, comp, sampleRateHz, obsPoint });
  }

  if (validStations.length === 0) {
    log("\n有効な観測点データがありませんでした。処理を中止します。");
    return null;
  }

  log(`\n${validStations.length}観測点をWorker(${WORKER_POOL_SIZE}並列)で処理します...`);
  setProgress(30);

  const pool = new WorkerPool(WORKER_POOL_SIZE);
  let firstHeader = null;
  let completedCount = 0;

  const results = await Promise.all(
    validStations.map(async (st) => {
      const recordStart = parseJstDateTime(st.comp.NS.header.recordTime);
      if (!firstHeader) firstHeader = st.comp.NS.header;

      const res = await pool.process({
        stationCode: st.code,
        obsId: st.obsPoint.id,
        ns: st.comp.NS.accelerationGal,
        ew: st.comp.EW.accelerationGal,
        ud: st.comp.UD.accelerationGal,
        sampleRateHz: st.sampleRateHz,
        recordTimeMs: recordStart.getTime(),
        windowSec,
        stepSec,
      });

      completedCount++;
      setProgress(30 + Math.round((completedCount / validStations.length) * 50)); // 30%〜80%

      if (res.type === "error") {
        log(`✗ ${st.code}: 処理エラー (${res.message})`);
        return null;
      }
      log(`✓ ${st.code}: id=${st.obsPoint.id} フレーム数=${res.series.length}`);
      return { obsId: st.obsPoint.id, series: res.series };
    })
  );

  pool.terminate();

  const stations = results.filter(Boolean);
  if (stations.length === 0) {
    log("\n全観測点でエラーが発生しました。処理を中止します。");
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
  log(`\n完了: ${stations.length}観測点, ${frames.length}フレーム, ${merged.byteLength}バイト`);

  return { blob: new Blob([merged], { type: "application/octet-stream" }), header: firstHeader, stationCount: stations.length };
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

$("processBtn").addEventListener("click", async () => {
  const files = $("fileInput").files;
  if (!files || files.length === 0) {
    alert("K-NET ASCIIファイル(またはzip)を選択してください");
    return;
  }
  const windowSec = Number($("windowSec").value) || 10;
  const stepSec = Number($("stepSec").value) || 1;

  $("processBtn").disabled = true;
  try {
    lastResult = await processAll(files, windowSec, stepSec);
    if (lastResult) {
      $("fileName").value = suggestFileName(lastResult.header);
      $("downloadBtn").style.display = "inline-block";
    }
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
