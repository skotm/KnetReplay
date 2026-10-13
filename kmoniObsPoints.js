/**
 * kmoniObsPoints.js
 * ------------------------------------------------------------
 * intensity-points.json(kmoni観測点: K-NET/KiK-net)から、
 * 観測点コード→MeteoQuakeでのid の対応表を作る。
 * meteoquake-realtime-collector/src/kmoni-obspoints-loader.ts のロジックと同一。
 */

const KMONI_ID_BASE = 1;
const KMONI_ID_MAX = 4999;

export function loadKmoniObsPointsByCode(raw) {
  const usable = raw.filter((p) => p.point !== null && !p.is_suspended);

  if (usable.length > KMONI_ID_MAX - KMONI_ID_BASE + 1) {
    throw new Error(`kmoni観測点数(${usable.length})がID割当範囲(${KMONI_ID_BASE}-${KMONI_ID_MAX})を超えています`);
  }

  const byCode = new Map();
  usable.forEach((p, i) => {
    byCode.set(p.code, {
      id: KMONI_ID_BASE + i,
      stationCode: p.code,
      name: p.name,
      latitude: p.location.latitude,
      longitude: p.location.longitude,
    });
  });
  return byCode;
}
