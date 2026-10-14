/**
 * knetDirection.js
 * ------------------------------------------------------------
 * K-NET / KiK-net の「方向(チャンネル)」判定。
 *
 * K-NET: 地表のみ。Dir. は "N-S" / "E-W" / "U-D"。
 * KiK-net: 地中・地表のペアで6チャンネル(防災科研のASCIIフォーマット仕様):
 *   ch1=NS(地中, 拡張子NS1)  ch2=EW(地中, EW1)  ch3=UD(地中, UD1)
 *   ch4=NS(地表, 拡張子NS2)  ch5=EW(地表, EW2)  ch6=UD(地表, UD2)
 * 震度計算には地表(ch4〜6)を使い、地中(ch1〜3)は使わない。
 *
 * Dir.欄の表記ゆれ(数値コード "1"〜"6" / "N-S1"・"N-S2" など)と、
 * ファイル名の拡張子(.NS1 / .NS2 など)の両方を見て判定する。
 * 優先順位: Dir.欄の数値コード → Dir.欄の末尾の1/2 → ファイル名の拡張子 → 添え字なし(K-NET)=地表
 */

const AXIS_PATTERN = /^(N-?S|E-?W|U-?D|VERT)\s*([12])?$/;

function axisFromText(text) {
  if (text.startsWith("N")) return "NS";
  if (text.startsWith("E")) return "EW";
  return "UD"; // U-D / VERT
}

/**
 * @param {string} raw ヘッダの Dir. 欄
 * @param {string} [fileName] ファイル名(拡張子がNS1/NS2等のとき補助に使う)
 * @returns {{axis: "NS"|"EW"|"UD", placement: "surface"|"borehole", channel: number|null} | null}
 *   channel は KiK-net のチャンネル番号(1〜6)。K-NETなど番号が無い場合は null
 */
export function normalizeDirection(raw, fileName = "") {
  const trimmed = String(raw ?? "").trim();

  // 1) 数値コード(KiK-net): 1〜3=地中, 4〜6=地表
  const numeric = {
    1: ["NS", "borehole"], 2: ["EW", "borehole"], 3: ["UD", "borehole"],
    4: ["NS", "surface"], 5: ["EW", "surface"], 6: ["UD", "surface"],
  };
  if (/^[1-6]$/.test(trimmed)) {
    const ch = Number(trimmed);
    const [axis, placement] = numeric[ch];
    return { axis, placement, channel: ch };
  }

  const s = trimmed.toUpperCase();
  const m = s.match(AXIS_PATTERN);
  const axis = m ? axisFromText(m[1]) : fallbackAxis(s);
  if (!axis) return null;

  // 2) Dir.欄の末尾の1/2 (N-S1=地中, N-S2=地表)
  if (m && m[2]) return fromSuffix(axis, m[2]);

  // 3) ファイル名の拡張子 (.NS1 / .ns2 など)
  const ext = String(fileName).toLowerCase().match(/\.(ns|ew|ud)([12])$/);
  if (ext) return fromSuffix(axis, ext[2]);

  // 4) 添え字なし(K-NET)は地表
  return { axis, placement: "surface", channel: null };
}

function fromSuffix(axis, suffix) {
  const borehole = suffix === "1";
  const base = { NS: 0, EW: 1, UD: 2 }[axis];
  return { axis, placement: borehole ? "borehole" : "surface", channel: (borehole ? 1 : 4) + base };
}

// 想定外の表記("NS-component" など)でも軸だけは拾う(従来動作の維持)
function fallbackAxis(s) {
  const t = s.replace(/[-\s]/g, "");
  if (t.includes("NS") || t === "N") return "NS";
  if (t.includes("EW") || t === "E") return "EW";
  if (t.includes("UD") || t.includes("VERT") || t === "U") return "UD";
  return null;
}
