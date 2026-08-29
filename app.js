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

/** "N-S" / "E-W" / "U-D" 等の表記ゆれを吸収して NS/EW/UD に正規化する */
function normalizeDirection(raw) {
  const s = raw.toUpperCase().replace(/[-\s]/g, "");
  if (s.includes("NS") || s === "N") return "NS";
  if (s.includes("EW") || s === "E") return "EW";
  if (s.includes("UD") || s.includes("VERT") || s === "U") return "UD";
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

async function readFileGroups(files) {
  // 各ファイルをパースし、観測点コード+方向でグループ化する
  const groups = new Map(); // stationCode -> { NS, EW, UD }

  for (const file of files) {
    const text = await file.text();
    let parsed;
    try {
      parsed = parseKnetAscii(text);
    } catch (e) {
      log(`✗ ${file.name}: パース失敗 (${e.message})`);
      continue;
    }
    const dir = normalizeDirection(parsed.header.direction);
    if (!dir) {
      log(`✗ ${file.name}: 方向(Dir.)を認識できません ("${parsed.header.direction}")`);
      continue;
    }
    const code = parsed.header.stationCode;
    if (!groups.has(code)) groups.set(code, {});
    groups.get(code)[dir] = parsed;
    log(`✓ ${file.name}: ${code} / ${dir} として読み込み`);
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
