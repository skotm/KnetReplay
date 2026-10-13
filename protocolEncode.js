/**
 * protocolEncode.js
 * ------------------------------------------------------------
 * リアルタイム配信(/v1/stream)と全く同じバイナリ形式のエンコーダ。
 * 詳細は meteoquake-realtime-collector/src/protocol.ts のコメント参照。
 */

export const NO_DATA_SENTINEL = -32768;

export function encodeIntensityDelta(dataTime, entries) {
  if (entries.length > 0xffff) {
    throw new Error(`entryCountがuint16に収まりません: ${entries.length}`);
  }

  const buf = new ArrayBuffer(7 + entries.length * 4);
  const view = new DataView(buf);

  view.setUint8(0, 0x01);
  view.setUint32(1, Math.floor(dataTime.getTime() / 1000), true);
  view.setUint16(5, entries.length, true);

  let offset = 7;
  for (const entry of entries) {
    if (entry.id < 0 || entry.id > 0xffff) {
      throw new Error(`id がuint16範囲外です: ${entry.id}`);
    }
    view.setUint16(offset, entry.id, true);

    const scaled = entry.intensity === null ? NO_DATA_SENTINEL : Math.round(entry.intensity * 100);
    if (scaled !== NO_DATA_SENTINEL && (scaled < -32767 || scaled > 32767)) {
      throw new Error(`intensityがint16表現範囲外です: id=${entry.id} value=${entry.intensity}`);
    }
    view.setInt16(offset + 2, scaled, true);

    offset += 4;
  }

  return buf;
}

export function diffIntensityMaps(previous, current) {
  const entries = [];

  for (const [id, value] of current) {
    const prevValue = previous.get(id);
    if (prevValue === undefined || Math.round(prevValue * 100) !== Math.round(value * 100)) {
      entries.push({ id, intensity: value });
    }
  }

  for (const id of previous.keys()) {
    if (!current.has(id)) {
      entries.push({ id, intensity: null });
    }
  }

  return entries;
}
