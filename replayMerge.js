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
 * K-NETは観測点ごとにトリガー式で記録するため、同じ観測点でも「1つ目の地震の記録終了
 * 〜2つ目の地震の記録開始」の間に未収録の空白ができる(例: M6.1→M7.4で平均約19秒)。
 * 結合時、ファイルをまたいで途切れている短い区間は補間して埋められる(gapFill)。
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
 * デコード済みリプレイから、観測点ごとの「連続して値がある区間(span)」を抽出する。
 * endExcl は排他的終端(その時刻にはもう無い)。nullフレームで閉じ、最後まで閉じなかった
 * ものは lastTs + 1 までとする。
 * @returns {Map<number, {start:number,endExcl:number,firstValue:number,lastValue:number}[]>}
 */
export function extractSpans(decoded) {
  const spans = new Map();
  const open = new Map();
  const push = (id, sp) => {
    if (!spans.has(id)) spans.set(id, []);
    spans.get(id).push(sp);
  };
  for (const fr of decoded.frames) {
    for (const e of fr.entries) {
      const sp = open.get(e.id);
      if (e.value === NO_DATA_SENTINEL) {
        if (sp) {
          sp.endExcl = fr.ts;
          push(e.id, sp);
          open.delete(e.id);
        }
      } else if (sp) {
        sp.lastValue = e.value;
      } else {
        open.set(e.id, { start: fr.ts, endExcl: 0, firstValue: e.value, lastValue: e.value });
      }
    }
  }
  for (const [id, sp] of open) {
    sp.endExcl = decoded.lastTs + 1;
    push(id, sp);
  }
  return spans;
}

/**
 * ファイルをまたいで途切れている区間(同じ観測点が、別のファイルの記録に移る間の空白)を
 * 検出する。同一ファイル内の途切れ(記録そのものの終了)は対象外。
 * @returns {{id:number, from:number, to:number, v0:number, v1:number}[]}
 *   from〜to-1 が空白(秒)。v0 は空白直前の値、v1 は空白直後の値(intensity×100)
 */
export function findGaps(spansPerSource, maxGapSec) {
  const byId = new Map();
  spansPerSource.forEach((m, src) => {
    for (const [id, list] of m) {
      if (!byId.has(id)) byId.set(id, []);
      for (const sp of list) byId.get(id).push({ ...sp, src });
    }
  });

  const gaps = [];
  for (const [id, list] of byId) {
    list.sort((a, b) => a.start - b.start || a.endExcl - b.endExcl);
    let cover = null;
    for (const sp of list) {
      if (!cover) {
        cover = { end: sp.endExcl, last: sp.lastValue, src: sp.src };
        continue;
      }
      if (sp.start < cover.end) {
        // 重なり: 終端がより遅い方を「ここまでの被覆」とする
        if (sp.endExcl > cover.end) cover = { end: sp.endExcl, last: sp.lastValue, src: sp.src };
        continue;
      }
      const len = sp.start - cover.end;
      if (len > 0 && len <= maxGapSec && cover.src !== sp.src) {
        gaps.push({ id, from: cover.end, to: sp.start, v0: cover.last, v1: sp.firstValue });
      }
      cover = { end: sp.endExcl, last: sp.lastValue, src: sp.src };
    }
  }
  return gaps;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * 複数のデコード済みリプレイを結合する。
 *
 * 各ファイルは自分の時間範囲 [firstTs, lastTs] の間だけ観測点を提供する。
 * 範囲外(開始前・終了後)では、そのファイルの観測点は「データ無し」として扱う。
 * (リプレイは差分形式なので、終了後も値を保持し続けると他ファイルの区間で
 *  古い値が残り続けてしまうため。)
 *
 * 同じ観測点がファイルをまたいで途切れている区間は、既定では埋めない。観測点は空白の
 * 間だけ「データ無し」で消え、次のファイルの記録が始まった時点で再び現れる
 * (info.reappear に、その観測点数と最長の空白を報告する)。
 * 希望すれば gapFill で、短い空白を直前・直後の値から補間することもできる(補間値は
 * 実測値ではない)。
 *
 * @param {ReturnType<typeof decodeReplay>[]} decodedList
 * @param {object} [options]
 * @param {"max"|"earliest"} [options.conflict]
 *   同じ観測点IDが同じ時刻に複数ファイルにある場合の扱い
 *     "max"      … 最大の震度を採用(既定)
 *     "earliest" … 開始時刻が最も早いファイルの値を採用
 * @param {{method?: "linear"|"hold"|"none", maxSec?: number}} [options.gapFill]
 *   method: "none"=補間しない(既定。空白の間は観測点が一度消え、空白後に再び現れる) /
 *           "linear"=直線補間 / "hold"=直前の値を保持
 *   maxSec: 補間する場合、これより長い空白は補間しない(既定60秒)
 * @returns {{bytes: Uint8Array, info: object}}
 */
export function mergeReplays(decodedList, options = {}) {
  const conflict = options.conflict ?? "max";
  const gapMethod = options.gapFill?.method ?? "none";
  const gapMaxSec = options.gapFill?.maxSec ?? 60;
  if (decodedList.length === 0) throw new Error("結合するファイルがありません");

  // 開始時刻の早い順に並べる("earliest"優先順位のため)
  const sources = decodedList
    .map((d, originalIndex) => ({ d, originalIndex, cursor: 0, cur: new Map() }))
    .sort((a, b) => a.d.firstTs - b.d.firstTs || a.originalIndex - b.originalIndex);

  const unionTs = [...new Set(sources.flatMap((s) => s.d.frames.map((f) => f.ts)))].sort((a, b) => a - b);

  // ファイルをまたぐ空白(同じ観測点が一度消えて再び現れる区間)を検出する。
  // allGaps は報告用(長さ無制限)、gaps は補間する分だけ。
  const allGaps = sources.length > 1 ? findGaps(sources.map((s) => extractSpans(s.d)), Infinity) : [];
  const gaps = gapMethod !== "none" && gapMaxSec > 0 ? allGaps.filter((g) => g.to - g.from <= gapMaxSec) : [];
  let timestamps = unionTs;
  if (gaps.length > 0) {
    let step = 0;
    for (let i = 1; i < unionTs.length; i++) step = gcd(step, unionTs[i] - unionTs[i - 1]);
    step = Math.max(1, step);
    const all = new Set(unionTs);
    for (const g of gaps) for (let t = g.from; t < g.to; t += step) all.add(t);
    timestamps = [...all].sort((a, b) => a - b);
  }
  gaps.sort((a, b) => a.from - b.from);
  let gapCursor = 0;
  let activeGaps = [];

  const frames = [];
  let previous = new Map();
  let hasBaseline = false;
  let conflictCount = 0;
  let filledSamples = 0;
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

    // 空白の補間
    while (gapCursor < gaps.length && gaps[gapCursor].from <= ts) activeGaps.push(gaps[gapCursor++]);
    if (activeGaps.length > 0) {
      activeGaps = activeGaps.filter((g) => ts < g.to);
      for (const g of activeGaps) {
        if (merged.has(g.id)) continue; // 他のファイルに実測値があればそちらを優先
        let v = g.v0;
        if (gapMethod === "linear") {
          const t0 = g.from - 1; // 直前の実測値の時刻
          v = g.v0 + ((g.v1 - g.v0) * (ts - t0)) / (g.to - t0);
        }
        merged.set(g.id, Math.round(v) / 100);
        stationIds.add(g.id);
        filledSamples++;
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
      reappear: {
        stationCount: new Set(allGaps.map((g) => g.id)).size,
        longestSec: allGaps.reduce((m, g) => Math.max(m, g.to - g.from), 0),
        totalSec: allGaps.reduce((sum, g) => sum + (g.to - g.from), 0),
      },
      gapFill: {
        method: gapMethod,
        maxSec: gapMaxSec,
        stationCount: new Set(gaps.map((g) => g.id)).size,
        gapCount: gaps.length,
        longestSec: gaps.reduce((m, g) => Math.max(m, g.to - g.from), 0),
        filledSamples,
      },
    },
  };
}
