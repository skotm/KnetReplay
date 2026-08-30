/**
 * app.js
 * ------------------------------------------------------------
 * ブラウザ側のオーケストレーション。
 *  1. ユーザーが選択/ドロップした複数ファイルをテキストとして読み込む
 *  2. 各ファイルをK-NET ASCIIとしてパースし、観測点コード+方向でグループ化
 *  3. NS/EW/UDが揃った観測点ごとにJMAフィルタ→震度時系列を計算
 *  4. intensity-points.jsonと突き合わせてid割当
 *  5. 全観測点をタイムライン統合し、リアルタイム配信と同じバイナリ形式で書き出す
 */
import { applyJmaFilter, vectorCompose, findAmplitudeAt03SecondsDuration, amplitudeToIntensity } from "./jmaIntensity.js";
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

  // KiK-net形式: 数値コード
  const numericCode = { "1": ["NS", "surface"], "2": ["EW", "surface"], "3": ["UD", "surface"], "4": ["NS", "borehole"], "5": ["EW", "borehole"], "6": ["UD", "borehole"] };
  if (numericCode[trimmed]) {
    const [axis, placement] = numericCode[trimmed];
    return { axis, placement };
  }

  // K-NET形式: 文字列表記
  const s = trimmed.toUpperCase().replace(/[-\s]/g, "");
  if (s.includes("NS") || s === "N") return { axis: "NS", placement: "surface" };
  if (s.includes("EW") || s === "E") return { axis: "EW", placement: "surface" };
  if (s.includes("UD") || s.includes("VERT") || s === "U") return { axis: "UD", placement: "surface" };

  return null;
}

function computeIntensityTimeSeries(filteredComposite, sampleRateHz, windowSec, stepSec) {
  const windowSamples = Math.round(windowSec * sampleRateHz);
  const stepSamples = Math.round(stepSec * sampleRateHz);
  const result = [];

  for (let start = 0; start + windowSamples <= filteredComposite.length; start += stepSamples) {
    const window = filteredComposite.slice(start, start + windowSamples);
    try {
      const a = findAmplitudeAt03SecondsDuration(window, sampleRateHz);
      const intensity = amplitudeToIntensity(a);
      const elapsedSec = (start + windowSamples) / sampleRateHz;
      result.push({ elapsedSec, intensity });
    } catch {
      // ウィンドウが短すぎる等でスキップ
    }
  }
  return result;
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
 * 選択されたファイル群を「テキストファイル(名前, 中身)」の平坦なリストに展開する。
 * zipファイルが含まれていれば自動的に展開する(中の全ファイルをテキストとして
 * 読み込もうとし、K-NET ASCIIとして解釈できないものは後段のパース失敗として
 * スキップされる。readme.txtやチャンネル表なども同様に読まれるが、ヘッダー
 * ラベルにマッチしないため自然に弾かれる)。
 */
async function expandFilesToTextEntries(files) {
  const entries = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      log(`zipを展開中: ${file.name}`);
      const zip = await JSZip.loadAsync(file);
      const zipEntries = Object.values(zip.files).filter((f) => !f.dir);
      for (const zf of zipEntries) {
        try {
          const text = await zf.async("text");
          entries.push({ name: zf.name.split("/").pop(), text });
        } catch (e) {
          log(`  ✗ ${zf.name}: zip内での読み込み失敗 (${e.message})`);
        }
      }
      log(`  ${file.name} から ${zipEntries.length}件のファイルを展開`);
    } else {
      entries.push({ name: file.name, text: await file.text() });
    }
  }
  return entries;
}

async function readFileGroups(files) {
  // 各ファイルをパースし、観測点コード+方向でグループ化する
  const groups = new Map(); // stationCode -> { NS, EW, UD }

  const textEntries = await expandFilesToTextEntries(files);

  for (const { name, text } of textEntries) {
    let parsed;
    try {
      parsed = parseKnetAscii(text);
    } catch (e) {
      log(`✗ ${name}: パース失敗 (${e.message})`);
      continue;
    }
    const dirInfo = normalizeDirection(parsed.header.direction);
    if (!dirInfo) {
      log(`✗ ${name}: 方向(Dir.)を認識できません ("${parsed.header.direction}")`);
      continue;
    }
    if (dirInfo.placement === "borehole") {
      log(`  ${name}: 地中(borehole)成分のためスキップ(表層側のみ使用)`);
      continue;
    }
    const code = parsed.header.stationCode;
    if (!groups.has(code)) groups.set(code, {});
    groups.get(code)[dirInfo.axis] = parsed;
    log(`✓ ${name}: ${code} / ${dirInfo.axis} として読み込み`);
  }

  return groups;
}

async function processAll(files, windowSec, stepSec) {
  $("log").textContent = "";
  setProgress(0);
  $("downloadBtn").style.display = "none";

  if (!obsPointsByCode) await loadObsPoints();

  const groups = await readFileGroups(files);

  const stations = [];
  let firstHeader = null;

  let processed = 0;
  const total = groups.size;

  for (const [code, comp] of groups) {
    processed++;
    setProgress(Math.round((processed / total) * 60)); // 前半60%をファイル処理に割り当てる

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

    if (!firstHeader) firstHeader = comp.NS.header;

    log(`  ${code}: フィルタ処理中... (${comp.NS.accelerationGal.length}サンプル, ${sampleRateHz}Hz)`);

    const nsFiltered = applyJmaFilter(comp.NS.accelerationGal, sampleRateHz);
    const ewFiltered = applyJmaFilter(comp.EW.accelerationGal, sampleRateHz);
    const udFiltered = applyJmaFilter(comp.UD.accelerationGal, sampleRateHz);
    const composite = vectorCompose(nsFiltered, ewFiltered, udFiltered);

    const timeSeries = computeIntensityTimeSeries(composite, sampleRateHz, windowSec, stepSec);
    const recordStart = parseJstDateTime(comp.NS.header.recordTime);
    const series = timeSeries.map((pt) => ({
      time: new Date(recordStart.getTime() + pt.elapsedSec * 1000),
      intensity: pt.intensity,
    }));

    log(`  ${code}: id=${obsPoint.id} フレーム数=${series.length}`);
    stations.push({ obsId: obsPoint.id, stationCode: code, series });

    // UIをブロックしないよう、1観測点処理するごとに一度制御を返す
    await new Promise((r) => setTimeout(r, 0));
  }

  if (stations.length === 0) {
    log("\n有効な観測点データがありませんでした。処理を中止します。");
    return null;
  }

  setProgress(70);

  // 全観測点の全時刻を統合タイムラインにする
  const allTimestampsMs = new Set();
  for (const st of stations) {
    for (const pt of st.series) {
      const roundedMs = Math.round(pt.time.getTime() / (stepSec * 1000)) * (stepSec * 1000);
      allTimestampsMs.add(roundedMs);
    }
  }
  const sortedTimestamps = [...allTimestampsMs].sort((a, b) => a - b);

  const valueByStationAndTime = new Map();
  for (const st of stations) {
    const m = new Map();
    for (const pt of st.series) {
      const roundedMs = Math.round(pt.time.getTime() / (stepSec * 1000)) * (stepSec * 1000);
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

  setProgress(90);

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
  // JST基準の日付にする(parseJstDateTimeは既にUTC基準のDateを返すため、+9hしてUTC gettersで取り出す)
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
    alert("K-NET ASCIIファイルを選択してください");
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
