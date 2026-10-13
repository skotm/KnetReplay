/**
 * replayMerge.js
 * ------------------------------------------------------------
 * 生成済みリプレイファイル(.bin)を複数読み込み、時刻に共通部分がある場合に
 * 1つのリプレイファイルへ結合する。
 *
 * リプレイファイルは「差分形式」(最初のフレームが全観測点、以降は変化した観測点のみ)
 * なので、バイト列の単純連結では結合できない。そのため:
 *   1. 各ファイルを「時刻ごとの全観測点の状態」に復元(decodeReplay)
 *   2. 全ファイルの時刻の和集合上で、各時刻の状態を合成(mergeReplays)
 *   3. 合成結果を差分フレームとして再エンコード
 * という手順を取る。
 *
 * フォーマット(protocolEncode.js と同じ):
 *   frame := 0x01, uint32 unixSec (LE), uint16 entryCount (LE), entry*
 *   entry := uint16 id (LE), int16 intensity×100 (LE)  ※ -32768 = データ無し
 *
 * このモジュールはDOMにもCDNにも依存しないので、Nodeで単体テストできる。
 */
import { encodeIntensityDelta, diffIntensityMaps, NO_DATA_SENTINEL } from "./protocolEncode.js";

/**
 * リプレイファイルをデコードする。
 * @param {ArrayBuffer} buffer
 * @returns {{frames: {ts: number, entries: {id:number, value:number}[]}[], firstTs: number, lastTs: number}}
 *   ts は unix秒、value は intensity×100 の整数(NO_DATA_SENTINEL=データ無し)
 */
export function decodeReplay(buffer) {
  const view = new DataView(buffer);
  const frames = [];
  let offset = 0;

  while (offset < view.byteLength) {
    if (offset + 7 > view.byteLength) {
      throw new Error(`フレームヘッダが途中で切れています (offset=${offset})`);
    }
    const type = view.getUint8(offset);
    if (type !== 0x01) {
      throw new Error(`未対応のフレーム種別 0x${type.toString(16)} (offset=${offset})。リプレイファイルではない可能性があります`);
    }
    const ts = view.getUint32(offset + 1, true);
    const count = view.getUint16(offset + 5, true);
    offset += 7;
    if (offset + count * 4 > view.byteLength) {
      throw new Error(`フレーム本体が途中で切れています (offset=${offset})`);
    }
    const entries = new Array(count);
    for (let i = 0; i < count; i++) {
      entries[i] = { id: view.getUint16(offset, true), value: view.getInt16(offset + 2, true) };
      offset += 4;
    }
    frames.push({ ts, entries });
  }

  if (frames.length === 0) throw new Error("フレームが1つもありません");

  for (let i = 1; i < frames.length; i++) {
    if (frames[i].ts < frames[i - 1].ts) {
      throw new Error(`フレームの時刻が昇順ではありません (${frames[i - 1].ts} → ${frames[i].ts})`);
    }
  }

  return { frames, firstTs: frames[0].ts, lastTs: frames[frames.length - 1].ts };
}

/**
 * 時刻範囲 [firstTs, lastTs] が(推移的に)つながっているか判定する。
 * 1秒でも共通部分(端点が一致する場合を含む)があればつながっているとみなす。
 * @param {{firstTs:number,lastTs:number}[]} decodedList
 * @returns {{connected: boolean, groups: number[][]}} groups は入力インデックスのグループ(開始時刻順)
 */
export function checkOverlap(decodedList) {
  const order = decodedList.map((_, i) => i).sort((a, b) => decodedList[a].firstTs - decodedList[b].firstTs);
  const groups = [];
  let current = [];
  let currentEnd = -Infinity;
  for (const i of order) {
    const d = decodedList[i];
    if (current.length === 0 || d.firstTs <= currentEnd) {
      current.push(i);
      currentEnd = Math.max(currentEnd, d.lastTs);
    } else {
      groups.push(current);
      current = [i];
      currentEnd = d.lastTs;
    }
  }
  if (current.length > 0) groups.push(current);
  return { connected: groups.length === 1, groups };
}

/**
 * 複数のデコード済みリプレイを結合する。
 *
 * 各ファイルは自分の時間範囲 [firstTs, lastTs] の間だけ観測点を提供する。
 * 範囲外(開始前・終了後)では、そのファイルの観測点は「データ無し」として扱う。
 * (リプレイは差分形式なので、終了後も値を保持し続けると他ファイルの区間で
 *  古い値が残り続けてしまうため。)
 *
 * @param {ReturnType<typeof decodeReplay>[]} decodedList
 * @param {{conflict?: "max"|"earliest"}} [options]
 *   conflict: 同じ観測点IDが同じ時刻に複数ファイルにある場合の扱い
 *     "max"      … 最大の震度を採用(既定)
 *     "earliest" … 開始時刻が最も早いファイルの値を採用
 * @returns {{bytes: Uint8Array, info: object}}
 */
export function mergeReplays(decodedList, options = {}) {
  const conflict = options.conflict ?? "max";
  if (decodedList.length === 0) throw new Error("結合するファイルがありません");

  // 開始時刻の早い順に並べる("earliest"優先順位のため)
  const sources = decodedList
    .map((d, originalIndex) => ({ d, originalIndex, cursor: 0, cur: new Map() }))
    .sort((a, b) => a.d.firstTs - b.d.firstTs || a.originalIndex - b.originalIndex);

  const timestamps = [...new Set(sources.flatMap((s) => s.d.frames.map((f) => f.ts)))].sort((a, b) => a - b);

  const frames = [];
  let previous = new Map();
  let hasBaseline = false;
  let conflictCount = 0;
  const stationIds = new Set();

  for (const ts of timestamps) {
    const merged = new Map(); // id -> intensity(震度の実数値)

    for (const s of sources) {
      // このファイルの、ts以下のフレームを適用して現在状態を更新
      const fr = s.d.frames;
      while (s.cursor < fr.length && fr[s.cursor].ts <= ts) {
        for (const e of fr[s.cursor].entries) {
          if (e.value === NO_DATA_SENTINEL) s.cur.delete(e.id);
          else s.cur.set(e.id, e.value);
        }
        s.cursor++;
      }

      const active = ts >= s.d.firstTs && ts <= s.d.lastTs;
      if (!active) continue;

      for (const [id, value] of s.cur) {
        const intensity = value / 100;
        const existing = merged.get(id);
        if (existing === undefined) {
          merged.set(id, intensity);
        } else {
          conflictCount++;
          if (conflict === "max" && intensity > existing) merged.set(id, intensity);
          // "earliest": sources は開始時刻順なので、先に入った値を残す
        }
        stationIds.add(id);
      }
    }

    const time = new Date(ts * 1000);
    if (!hasBaseline) {
      const baseline = [...merged.entries()].map(([id, intensity]) => ({ id, intensity }));
      frames.push(new Uint8Array(encodeIntensityDelta(time, baseline)));
      hasBaseline = true;
    } else {
      const diff = diffIntensityMaps(previous, merged);
      if (diff.length > 0) frames.push(new Uint8Array(encodeIntensityDelta(time, diff)));
    }
    previous = merged;
  }

  const totalLength = frames.reduce((sum, f) => sum + f.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const f of frames) {
    bytes.set(f, offset);
    offset += f.byteLength;
  }

  return {
    bytes,
    info: {
      firstTs: timestamps[0],
      lastTs: timestamps[timestamps.length - 1],
      frameCount: frames.length,
      stationCount: stationIds.size,
      conflictCount,
    },
  };
}
