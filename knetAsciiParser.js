/**
 * knetAsciiParser.js
 * ------------------------------------------------------------
 * K-NET ASCIIフォーマットのパーサー。
 * 出典: 防災科学技術研究所 K-NET/KiK-net
 * https://www.kyoshin.bosai.go.jp/kyoshin/man/knetform.html
 */

const HEADER_FIELD_LABELS = [
  { key: "originTime", labels: ["Origin Time"] },
  { key: "_skip", labels: ["Lat."] },
  { key: "_skip", labels: ["Lon.", "Long."] },
  { key: "_skip", labels: ["Depth. (km)", "Depth.(km)"] },
  { key: "magnitude", labels: ["Mag."] },
  { key: "stationCode", labels: ["Station Code"] },
  { key: "stationLat", labels: ["Station Lat."] },
  { key: "stationLon", labels: ["Station Lon.", "Station Long."] },
  { key: "stationHeightM", labels: ["Station Height(m)"] },
  { key: "recordTime", labels: ["Record Time"] },
  { key: "samplingFreqHz", labels: ["Sampling Freq(Hz)"] },
  { key: "durationSeconds", labels: ["Duration Time(s)"] },
  { key: "direction", labels: ["Dir."] },
  { key: "_scaleFactor", labels: ["Scale Factor"] },
  { key: "maxAccGal", labels: ["Max. Acc. (gal)", "Max Acc. (gal)", "Max. Acc.(gal)"] },
  { key: "_skip", labels: ["Last Correction"] },
];

function matchLabel(line, candidates) {
  for (const label of candidates) {
    if (line.startsWith(label)) {
      return line.slice(label.length).trim();
    }
  }
  return null;
}

function parseScaleFactor(raw) {
  const match = raw.match(/([-\d.]+)\s*\(gal\)\s*\/\s*(\d+)/);
  if (!match) {
    throw new Error(`Scale Factorの形式が不正です: "${raw}"`);
  }
  return { numerator: parseFloat(match[1]), denominator: parseInt(match[2], 10) };
}

function parseHzValue(raw) {
  const match = raw.match(/([\d.]+)/);
  if (!match) throw new Error(`サンプリング周波数の形式が不正です: "${raw}"`);
  return parseFloat(match[1]);
}

export function parseKnetAscii(content) {
  const lines = content.split(/\r?\n/);

  const partialHeader = {};
  let scaleFactor = null;

  let lineIndex = 0;

  for (; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.trim().length === 0) continue;

    let matched = false;
    for (const field of HEADER_FIELD_LABELS) {
      const value = matchLabel(line, field.labels);
      if (value === null) continue;
      matched = true;

      switch (field.key) {
        case "originTime":
          partialHeader.originTime = value;
          break;
        case "magnitude":
          partialHeader.magnitude = parseFloat(value);
          break;
        case "stationCode":
          partialHeader.stationCode = value;
          break;
        case "stationLat":
          partialHeader.stationLat = parseFloat(value);
          break;
        case "stationLon":
          partialHeader.stationLon = parseFloat(value);
          break;
        case "stationHeightM":
          partialHeader.stationHeightM = parseFloat(value);
          break;
        case "recordTime":
          partialHeader.recordTime = value;
          break;
        case "samplingFreqHz":
          partialHeader.samplingFreqHz = parseHzValue(value);
          break;
        case "durationSeconds":
          partialHeader.durationSeconds = parseFloat(value);
          break;
        case "direction":
          partialHeader.direction = value;
          break;
        case "maxAccGal":
          partialHeader.maxAccGal = parseFloat(value);
          break;
        case "_scaleFactor":
          scaleFactor = parseScaleFactor(value);
          break;
        default:
          break;
      }
      break;
    }

    if (!matched) {
      const tokens = line.trim().split(/\s+/);
      const looksNumeric = tokens.length > 0 && tokens.every((t) => /^-?\d+(\.\d+)?$/.test(t));
      if (looksNumeric) {
        break;
      }
      continue;
    }
  }

  if (!partialHeader.originTime || !partialHeader.stationCode || !scaleFactor || !partialHeader.samplingFreqHz) {
    throw new Error("ヘッダーの必須項目が読み取れませんでした(ファイル形式が想定と異なる可能性があります)");
  }

  const digitalValues = [];
  for (; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (line.length === 0) continue;
    for (const tok of line.split(/\s+/)) {
      const v = parseInt(tok, 10);
      if (!Number.isNaN(v)) digitalValues.push(v);
    }
  }

  const accelerationGal = new Float64Array(digitalValues.length);
  for (let i = 0; i < digitalValues.length; i++) {
    accelerationGal[i] = (digitalValues[i] * scaleFactor.numerator) / scaleFactor.denominator;
  }

  const header = {
    originTime: partialHeader.originTime,
    magnitude: partialHeader.magnitude ?? 0,
    stationCode: partialHeader.stationCode,
    stationLat: partialHeader.stationLat ?? 0,
    stationLon: partialHeader.stationLon ?? 0,
    stationHeightM: partialHeader.stationHeightM ?? 0,
    recordTime: partialHeader.recordTime ?? "",
    samplingFreqHz: partialHeader.samplingFreqHz,
    durationSeconds: partialHeader.durationSeconds ?? accelerationGal.length / partialHeader.samplingFreqHz,
    direction: partialHeader.direction ?? "",
    scaleFactorNumerator: scaleFactor.numerator,
    scaleFactorDenominator: scaleFactor.denominator,
    maxAccGal: partialHeader.maxAccGal ?? 0,
  };

  return { header, accelerationGal };
}
