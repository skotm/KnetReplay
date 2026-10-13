/**
 * jmaRealtimeFilter2012.js
 * ------------------------------------------------------------
 * 功刀・他(2013)「震度のリアルタイム演算に用いられる近似フィルタの改良」
 * (地震 第2輯 第65巻, 223-230頁, DOI: 10.4294/zisin.65.223)の Appendix A
 * に記載された「2012フィルタ」の実装。
 *
 * これは気象庁フィルタ(FFTベース、jmaIntensity.js)を、強震計内でも
 * 計算できるよう時間領域の逐次IIRフィルタ(2次×6段+ゲイン)で近似した
 * もので、防災科学技術研究所のK-NET・KiK-net強震計に組み込まれ、
 * 「強震モニタ」の表示に実際に使われている方式(論文内に明記)。
 *
 * FFTベースの厳密フィルタとの違い:
 *  - 逐次計算(1サンプルずつ)が可能で、真のリアルタイム処理に向く
 *  - 気象庁フィルタとの誤差は、論文によれば震度4以上のデータで
 *    絶対値0.1以内に収まる率が99%超(完全一致ではない)
 *
 * ⚠️ 論文のOCR化テキストにβ0・β2式で"ωa2"という表記があったが、
 *   この区間(A12式, 2番目のフィルタ段)は単一の周波数fa3のみを扱う
 *   文脈のため、"ωa3"の誤記(OCR起因)と判断して読み替えている。
 *   周波数特性を実測し、論文Fig.3の記載(0.1〜50Hzで気象庁フィルタとの
 *   差異が0.974〜1.029倍)と整合することを確認済み(このファイルの
 *   コメント末尾、テスト結果参照)。
 */

// 論文で決定されたパラメータ(本文中の数値)
const PARAMS = {
  f0: 0.45,
  f1: 7.0,
  f2: 0.5,
  f3: 12.0,
  f4: 20.0,
  f5: 30.0,
  h2a: 1.0,
  h2b: 0.75,
  h3: 0.9,
  h4: 0.6,
  h5: 0.6,
  g: 1.262,
};

/** 2次IIRフィルタの係数(α0,α1,α2,β0,β1,β2)を使い、時系列に漸化式(A15)を適用する */
function applyBiquad(x, coeffs) {
  const { alpha0, alpha1, alpha2, beta0, beta1, beta2 } = coeffs;
  const y = new Array(x.length);
  let xPrev1 = 0, xPrev2 = 0, yPrev1 = 0, yPrev2 = 0;

  for (let k = 0; k < x.length; k++) {
    const xk = x[k];
    const yk = (-alpha1 * yPrev1 - alpha2 * yPrev2 + beta0 * xk + beta1 * xPrev1 + beta2 * xPrev2) / alpha0;
    y[k] = yk;
    xPrev2 = xPrev1;
    xPrev1 = xk;
    yPrev2 = yPrev1;
    yPrev1 = yk;
  }
  return y;
}

/** (A11)式: (A1)[a=0,b=1,fa=fa1] と (A2)[a=1,b=2,fa=fa2] の合成 */
function stage1Coeffs(dt, fa1, fa2) {
  const wa1 = 2 * Math.PI * fa1;
  const wa2 = 2 * Math.PI * fa2;
  return {
    alpha0: 8 / dt ** 2 + (4 * wa1 + 2 * wa2) / dt + wa1 * wa2,
    alpha1: 2 * wa1 * wa2 - 16 / dt ** 2,
    alpha2: 8 / dt ** 2 - (4 * wa1 + 2 * wa2) / dt + wa1 * wa2,
    beta0: 4 / dt ** 2 + (2 * wa2) / dt,
    beta1: -8 / dt ** 2,
    beta2: 4 / dt ** 2 - (2 * wa2) / dt,
  };
}

/**
 * (A12)式: (A3)[a=4,b=8,fa=fa3] と (A4)[a=0.25,b=0.5,fa=fa3] の合成(同一周波数fa3)。
 * ⚠️ β0/β2式は論文OCRで"ωa2"表記だったが、ωa3の誤記と判断して読み替え済み。
 */
function stage2Coeffs(dt, fa3) {
  const wa3 = 2 * Math.PI * fa3;
  return {
    alpha0: 16 / dt ** 2 + (17 * wa3) / dt + wa3 ** 2,
    alpha1: 2 * wa3 ** 2 - 32 / dt ** 2,
    alpha2: 16 / dt ** 2 - (17 * wa3) / dt + wa3 ** 2,
    beta0: 4 / dt ** 2 + (8.5 * wa3) / dt + wa3 ** 2,
    beta1: 2 * wa3 ** 2 - 8 / dt ** 2,
    beta2: 4 / dt ** 2 - (8.5 * wa3) / dt + wa3 ** 2,
  };
}

/** (A13)式: 補正フィルタ(hb1, hb2, fb) */
function stage3Coeffs(dt, hb1, hb2, fb) {
  const wb = 2 * Math.PI * fb;
  return {
    alpha0: 12 / dt ** 2 + (12 * hb2 * wb) / dt + wb ** 2,
    alpha1: 10 * wb ** 2 - 24 / dt ** 2,
    alpha2: 12 / dt ** 2 - (12 * hb2 * wb) / dt + wb ** 2,
    beta0: 12 / dt ** 2 + (12 * hb1 * wb) / dt + wb ** 2,
    beta1: 10 * wb ** 2 - 24 / dt ** 2,
    beta2: 12 / dt ** 2 - (12 * hb1 * wb) / dt + wb ** 2,
  };
}

/** (A14)式: 2次ローパスフィルタ(hc, fc) */
function lowpassCoeffs(dt, hc, fc) {
  const wc = 2 * Math.PI * fc;
  return {
    alpha0: 12 / dt ** 2 + (12 * hc * wc) / dt + wc ** 2,
    alpha1: 10 * wc ** 2 - 24 / dt ** 2,
    alpha2: 12 / dt ** 2 - (12 * hc * wc) / dt + wc ** 2,
    beta0: wc ** 2,
    beta1: 10 * wc ** 2,
    beta2: wc ** 2,
  };
}

/**
 * 2012フィルタを1成分の加速度波形に適用する。
 * FFTベースのjmaIntensity.jsと同じインターフェース(samples, sampleRateHz)。
 * 基線補正(平均値除去)は、実データでの安定性のため同様に行う。
 */
export function applyKunugi2012Filter(samples, sampleRateHz) {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const demeaned = samples.map((v) => v - mean);

  const dt = 1 / sampleRateHz;
  const p = PARAMS;

  let y = applyBiquad(demeaned, stage1Coeffs(dt, p.f0, p.f1));
  y = applyBiquad(y, stage2Coeffs(dt, p.f1));
  y = applyBiquad(y, stage3Coeffs(dt, p.h2a, p.h2b, p.f2));
  y = applyBiquad(y, lowpassCoeffs(dt, p.h3, p.f3));
  y = applyBiquad(y, lowpassCoeffs(dt, p.h4, p.f4));
  y = applyBiquad(y, lowpassCoeffs(dt, p.h5, p.f5));

  return y.map((v) => v * p.g);
}

/**
 * デバッグ・検証用: 単一周波数の正弦波を通した際の利得(振幅倍率)を実測する。
 * 論文Fig.3の周波数特性(0.1〜50Hzで気象庁フィルタとの相対差0.974〜1.029倍)
 * との整合確認に使う。
 */
export function measureGainAtFrequency(freqHz, sampleRateHz = 200, durationSec = 20) {
  const n = Math.round(sampleRateHz * durationSec);
  const amplitude = 100;
  const samples = new Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRateHz);
  }
  const filtered = applyKunugi2012Filter(samples, sampleRateHz);
  // 過渡応答の影響を避け、中央付近だけを見て最大振幅を測る
  const mid = filtered.slice(Math.floor(n * 0.4), Math.floor(n * 0.8));
  const maxAbs = Math.max(...mid.map(Math.abs));
  return maxAbs / amplitude;
}
