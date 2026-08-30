/**
 * intensityWorker.js
 * ------------------------------------------------------------
 * FFTフィルタ・震度計算はCPU負荷が高いため、メインスレッド
 * (UIの描画・応答性を担う)から切り離してWeb Worker上で実行する。
 * 大量の観測点を処理してもページが固まらないようにするための対応。
 *
 * メッセージ形式:
 *   受信: { type: "process", requestId, stationCode, obsId,
 *           ns, ew, ud, sampleRateHz, recordTimeMs, windowSec, stepSec }
 *   送信: { type: "result", requestId, obsId, stationCode, series }
 *         | { type: "error", requestId, message }
 */
import { applyJmaFilter, vectorCompose, findAmplitudeAt03SecondsDuration, amplitudeToIntensity } from "./jmaIntensity.js";

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

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type !== "process") return;

  const { requestId, stationCode, obsId, ns, ew, ud, sampleRateHz, recordTimeMs, windowSec, stepSec } = msg;

  try {
    const nsFiltered = applyJmaFilter(ns, sampleRateHz);
    const ewFiltered = applyJmaFilter(ew, sampleRateHz);
    const udFiltered = applyJmaFilter(ud, sampleRateHz);
    const composite = vectorCompose(nsFiltered, ewFiltered, udFiltered);

    const timeSeries = computeIntensityTimeSeries(composite, sampleRateHz, windowSec, stepSec);
    const series = timeSeries.map((pt) => ({
      timeMs: recordTimeMs + pt.elapsedSec * 1000,
      intensity: pt.intensity,
    }));

    self.postMessage({ type: "result", requestId, obsId, stationCode, series });
  } catch (e) {
    self.postMessage({ type: "error", requestId, message: String(e && e.message ? e.message : e) });
  }
};
