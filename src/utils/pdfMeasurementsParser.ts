export interface ParsedPdfStockpileItem {
  index: number;
  name: string;
  suggestedCode: string;
  fillVolumeM3: number;
  cutVolumeM3: number;
  netVolumeM3: number;
  area2dM2: number;
  baseElevationM?: number;
}

export interface Parsed3DsurveyPdfResult {
  software?: string;
  fileNameDateHint?: string;
  items: ParsedPdfStockpileItem[];
  totals: {
    count: number;
    fillVolumeM3: number;
    cutVolumeM3: number;
    netVolumeM3: number;
    area2dM2: number;
  };
}

/**
 * Reconstructs visual top-to-bottom, left-to-right text lines from PDF.js TextContent items.
 * Handles PDF streams where columns or cells are emitted out of visual Y-order.
 */
export function groupPdfTextItemsIntoLines(rawItems: readonly unknown[]): string[] {
  const positioned: Array<{ x: number; y: number; text: string }> = [];
  for (const rawItem of rawItems) {
    if (
      typeof rawItem !== 'object' ||
      rawItem === null ||
      !('str' in rawItem) ||
      !('transform' in rawItem)
    ) {
      continue;
    }
    const str = String((rawItem as { str: unknown }).str ?? '');
    if (!str.trim()) continue;
    const transform = (rawItem as { transform: number[] }).transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    positioned.push({ x, y, text: str });
  }

  // Sort strictly top-to-bottom (higher Y first in PDF coordinates), then left-to-right (lower X first)
  positioned.sort((a, b) => {
    if (Math.abs(b.y - a.y) > 2.8) return b.y - a.y;
    return a.x - b.x;
  });

  const rows: Array<{ y: number; tokens: Array<{ x: number; text: string }> }> = [];
  for (const item of positioned) {
    const lastRow = rows[rows.length - 1];
    if (!lastRow || Math.abs(item.y - lastRow.y) > 2.8) {
      rows.push({ y: item.y, tokens: [{ x: item.x, text: item.text }] });
    } else {
      lastRow.tokens.push({ x: item.x, text: item.text });
    }
  }

  return rows
    .map((row) =>
      row.tokens
        .sort((a, b) => a.x - b.x)
        .map((t) => t.text)
        .join(' ')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
}

function parseFlexiblePdfNumber(raw: string | undefined): number | undefined {
  const txt = String(raw ?? '').trim();
  if (!txt) return undefined;
  let cleaned = txt.replace(/\s+/g, '').replace(/[^\d,.-]/g, '');
  if (!cleaned) return undefined;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    const afterComma = cleaned.slice(lastComma + 1);
    if (afterComma.length === 3 && /^-?\d{1,3},\d{3}$/.test(cleaned)) {
      cleaned = cleaned.replace(/,/g, '');
    } else {
      cleaned = cleaned.replace(',', '.');
    }
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildSuggestedStockpileCode(name: string, index: number): string {
  const cleanName = String(name || '').trim();
  const numberedMatch = cleanName.match(/^(?:acopio|stockpile|mont[oó]n|pila)\s*#?\s*0*(\d+)$/i);
  if (numberedMatch) {
    const num = parseInt(numberedMatch[1], 10);
    return `ACO-${String(num).padStart(2, '0')}`;
  }

  const slug = cleanName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 14);

  if (slug) {
    return slug.startsWith('ACO-') ? slug : `ACO-${slug}`;
  }
  return `ACO-${String(index).padStart(2, '0')}`;
}

export function extractDateHintFromPdfFileName(fileName?: string): string | undefined {
  const raw = String(fileName || '');
  const dmyFull = raw.match(/(?:^|[^0-9])(\d{2})[_-](\d{2})[_-](\d{4})(?:[^0-9]|$)/);
  if (dmyFull) {
    const [, dd, mm, yyyy] = dmyFull;
    return `${yyyy}-${mm}-${dd}`;
  }
  const dmyShort = raw.match(/(?:^|[^0-9])(\d{2})[_-](\d{2})[_-](\d{2})(?:[^0-9]|$)/);
  if (dmyShort) {
    const [, dd, mm, yy] = dmyShort;
    const day = Number(dd);
    const mon = Number(mm);
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      return `20${yy}-${mm}-${dd}`;
    }
  }
  const ymd = raw.match(/(?:^|[^0-9])(\d{4})[_-](\d{2})[_-](\d{2})(?:[^0-9]|$)/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  return undefined;
}

interface WorkingBlock {
  name: string;
  fillVolumeM3?: number;
  cutVolumeM3?: number;
  netVolumeM3?: number;
  area2dM2?: number;
  baseElevationM?: number;
}

export function parse3DsurveyMeasurementsLines(
  lines: string[],
  fileName?: string
): Parsed3DsurveyPdfResult {
  const cleanedLines = lines
    .map((l) => l.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let software: string | undefined;
  const fullHeaderSample = cleanedLines.slice(0, 14).join(' ');
  const versionMatch = fullHeaderSample.match(/Versi[oó]n\s+([0-9]+(?:\.[0-9]+)*)/i);
  if (
    /3Dsurvey/i.test(fullHeaderSample) ||
    /procesamiento de im[áa]genes a[ée]reas/i.test(fullHeaderSample)
  ) {
    software = versionMatch ? `3Dsurvey v${versionMatch[1]}` : '3Dsurvey';
  } else if (versionMatch) {
    software = `v${versionMatch[1]}`;
  }

  const blocks: WorkingBlock[] = [];
  let current: WorkingBlock | null = null;
  let pendingNameFromNextLine = false;

  const flushCurrent = () => {
    if (!current) return;
    if (
      current.name &&
      (current.fillVolumeM3 !== undefined ||
        current.cutVolumeM3 !== undefined ||
        current.netVolumeM3 !== undefined ||
        current.area2dM2 !== undefined)
    ) {
      blocks.push(current);
    }
    current = null;
  };

  for (const line of cleanedLines) {
    if (/^volume_orthophoto_not_available$/i.test(line)) {
      continue;
    }

    if (pendingNameFromNextLine) {
      pendingNameFromNextLine = false;
      if (!/^(?:Relleno|Desmonte|Neto|[ÁA]rea)/i.test(line)) {
        current = { name: line };
        continue;
      }
    }

    const emptyNameMatch = line.match(/^(?:Volumen\s+|Volume\s+)?(?:Nombre|Name)\s*:\s*$/i);
    if (emptyNameMatch) {
      flushCurrent();
      pendingNameFromNextLine = true;
      continue;
    }

    const nameMatch = line.match(/^(?:Volumen\s+|Volume\s+)?(?:Nombre|Name)\s*:\s*(.+)$/i);
    if (nameMatch) {
      flushCurrent();
      current = {
        name: nameMatch[1].trim(),
      };
      continue;
    }

    if (!current) {
      const inlineName = line.match(/(?:Nombre|Name)\s*:\s*(.+)$/i);
      if (inlineName) {
        current = { name: inlineName[1].trim() };
      }
      continue;
    }

    const fillMatch = line.match(/(?:Relleno|Terrapl[eé]n|Fill(?:\s+volume)?)\s*:\s*([+-]?\d[\d.,]*)/i);
    if (fillMatch) {
      const val = parseFlexiblePdfNumber(fillMatch[1]);
      if (val !== undefined) current.fillVolumeM3 = val;
    }

    const cutMatch = line.match(/(?:Desmonte|Corte|Cut(?:\s+volume)?)\s*:\s*([+-]?\d[\d.,]*)/i);
    if (cutMatch) {
      const val = parseFlexiblePdfNumber(cutMatch[1]);
      if (val !== undefined) current.cutVolumeM3 = val;
    }

    const netMatch = line.match(/(?:Neto|Volumen\s+neto|Net(?:\s+volume)?)\s*:\s*([+-]?\d[\d.,]*)/i);
    if (netMatch) {
      const val = parseFlexiblePdfNumber(netMatch[1]);
      if (val !== undefined) current.netVolumeM3 = val;
    }

    const area2dMatch = line.match(/(?:[ÁA]rea\s*2D|Superficie\s*2D|2D\s*Area)\s*:\s*([+-]?\d[\d.,]*)/i);
    if (area2dMatch) {
      const val = parseFlexiblePdfNumber(area2dMatch[1]);
      if (val !== undefined) current.area2dM2 = val;
    }

    const lowMatch = line.match(
      /(?:Punto\s+m[áa]s\s+bajo|Cota\s+m[íi]n(?:ima)?|Lowest\s+point|Min\.?\s*elevation)\s*:\s*([+-]?\d[\d.,]*)/i
    );
    if (lowMatch) {
      const val = parseFlexiblePdfNumber(lowMatch[1]);
      if (val !== undefined) current.baseElevationM = val;
    }
  }

  flushCurrent();

  const usedCodes = new Set<string>();
  const items: ParsedPdfStockpileItem[] = blocks.map((b, idx) => {
    const fill = Math.round((b.fillVolumeM3 ?? 0) * 100) / 100;
    const cut = Math.round((b.cutVolumeM3 ?? 0) * 100) / 100;
    const net =
      b.netVolumeM3 !== undefined
        ? Math.round(b.netVolumeM3 * 100) / 100
        : Math.round((fill - cut) * 100) / 100;
    const area2d = Math.round((b.area2dM2 ?? 0) * 100) / 100;

    let code = buildSuggestedStockpileCode(b.name, idx + 1);
    if (usedCodes.has(code)) {
      code = `${code}-${idx + 1}`;
    }
    usedCodes.add(code);

    return {
      index: idx + 1,
      name: b.name,
      suggestedCode: code,
      fillVolumeM3: fill,
      cutVolumeM3: cut,
      netVolumeM3: net,
      area2dM2: area2d,
      baseElevationM: b.baseElevationM,
    };
  });

  const totals = items.reduce(
    (acc, item) => {
      acc.fillVolumeM3 += item.fillVolumeM3;
      acc.cutVolumeM3 += item.cutVolumeM3;
      acc.netVolumeM3 += item.netVolumeM3;
      acc.area2dM2 += item.area2dM2;
      return acc;
    },
    {
      count: items.length,
      fillVolumeM3: 0,
      cutVolumeM3: 0,
      netVolumeM3: 0,
      area2dM2: 0,
    }
  );

  return {
    software,
    fileNameDateHint: extractDateHintFromPdfFileName(fileName),
    items,
    totals: {
      count: totals.count,
      fillVolumeM3: Math.round(totals.fillVolumeM3 * 100) / 100,
      cutVolumeM3: Math.round(totals.cutVolumeM3 * 100) / 100,
      netVolumeM3: Math.round(totals.netVolumeM3 * 100) / 100,
      area2dM2: Math.round(totals.area2dM2 * 100) / 100,
    },
  };
}
