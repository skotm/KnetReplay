/**
 * jmaIntensity.js
 * ------------------------------------------------------------
 * 気象庁の計測震度算出方法(気象庁[1996])をそのまま実装したもの。
 * 出典: 気象庁「計測震度の算出方法」
 * https://www.jma.go.jp/jma/kishou/know/jishin/kyoshin/kaisetsu/calc_sindo.html
 *
 * 手順:
 *  1. 3成分(NS/EW/UD)加速度波形をそれぞれフーリエ変換
 *  2. 周波数領域でフィルタ(ローカット×ハイカット×周期効果)を掛ける
 *  3. 逆フーリエ変換で時刻歴波形に戻す
 *  4. 3成分をベクトル合成: a(t) = sqrt(NS(t)^2 + EW(t)^2 + UD(t)^2)
 *  5. |a(t)| >= a となる時間の合計がちょうど0.3秒になるようなaを求める
 *  6. I = 2*log10(a) + 0.94 (小数第3位を四捨五入し、小数第2位を切り捨て)
 *
 * 実例による検証(気象庁ページ記載): a=127.85 galのとき I=5.15(記事中は「5.1」と概数表記)
 */
import FFT from "https://cdn.jsdelivr.net/npm/fft.js@4.0.4/+esm";

export function jmaFilterMagnitude(f) {
  if (f <= 0) return 0;

  const fl = Math.sqrt(1 - Math.exp(-Math.pow(f / 0.5, 3)));

  const y = f / 10;
  const y2 = y * y;
  const denomInner =
    1 +
    0.694 * y2 +
    0.241 * Math.pow(y2, 2) +
    0.0557 * Math.pow(y2, 3) +
    0.009664 * Math.pow(y2, 4) +
    0.00134 * Math.pow(y2, 5) +
    0.000155 * Math.pow(y2, 6);
  const fh = 1 / Math.sqrt(denomInner);

  const ff = Math.sqrt(1 / f);

  return fl * fh * ff;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export function applyJmaFilter(samples, sampleRateHz) {
  // 基線補正(直流バイアス除去)。生の加速度データには観測点固有の大きな
  // オフセット(数十gal程度)が乗っていることがあり、そのままゼロパディング
  // すると境界に不連続(ステップ)が生じ、フィルタ後に実際の揺れとは
  // 無関係な巨大な人工的振動(リンギング)が出てしまう(実データで確認済みの
  // 不具合)。平均値を引いてから処理することでこれを防ぐ。
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const demeaned = samples.map((v) => v - mean);

  const n = nextPowerOfTwo(demeaned.length);
  const fft = new FFT(n);

  const input = fft.createComplexArray();
  for (let i = 0; i < demeaned.length; i++) {
    input[2 * i] = demeaned[i];
    input[2 * i + 1] = 0;
  }
  for (let i = demeaned.length; i < n; i++) {
    input[2 * i] = 0;
    input[2 * i + 1] = 0;
  }

  const spectrum = fft.createComplexArray();
  fft.transform(spectrum, input);

  const freqResolution = sampleRateHz / n;
  for (let k = 0; k < n; k++) {
    const binIndex = k <= n / 2 ? k : k - n;
    const freq = Math.abs(binIndex) * freqResolution;
    const mag = jmaFilterMagnitude(freq);
    spectrum[2 * k] *= mag;
    spectrum[2 * k + 1] *= mag;
  }

  const output = fft.createComplexArray();
  fft.inverseTransform(output, spectrum);

  const result = new Array(demeaned.length);
  for (let i = 0; i < demeaned.length; i++) {
    result[i] = output[2 * i];
  }
  return result;
}

export function vectorCompose(ns, ew, ud) {
  const len = Math.min(ns.length, ew.length, ud.length);
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = Math.sqrt(ns[i] * ns[i] + ew[i] * ew[i] + ud[i] * ud[i]);
  }
  return result;
}

export function findAmplitudeAt03SecondsDuration(amplitude, sampleRateHz) {
  const targetSampleCount = Math.round(0.3 * sampleRateHz);
  if (targetSampleCount < 1) {
    throw new Error("サンプリング周波数が低すぎて0.3秒に相当するサンプル数を確保できません");
  }
  if (amplitude.length < targetSampleCount) {
    throw new Error("波形が短すぎて0.3秒継続時間法を適用できません");
  }

  const sorted = [...amplitude].sort((a, b) => b - a);
  return sorted[targetSampleCount - 1];
}

export function amplitudeToIntensity(a) {
  if (a <= 0) return -Infinity;
  const raw = 2 * Math.log10(a) + 0.94;
  const roundedTo3 = Math.round(raw * 1000) / 1000;
  const truncatedTo2 = Math.floor(roundedTo3 * 100) / 100;
  return truncatedTo2;
}

export function calculateJmaIntensity(ns, ew, ud, sampleRateHz) {
  const nsFiltered = applyJmaFilter(ns, sampleRateHz);
  const ewFiltered = applyJmaFilter(ew, sampleRateHz);
  const udFiltered = applyJmaFilter(ud, sampleRateHz);
  const composed = vectorCompose(nsFiltered, ewFiltered, udFiltered);
  const a = findAmplitudeAt03SecondsDuration(composed, sampleRateHz);
  return amplitudeToIntensity(a);
}
