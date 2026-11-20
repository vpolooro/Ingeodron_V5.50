import type { DxfPoint3D, DxfPolygonRegion, FlightDxfOverlay, Stockpile } from '../types.ts';

const ACI_HEX_PALETTE: Record<number, string> = {
  1: '#ef4444', // Red
  2: '#eab308', // Yellow
  3: '#22c55e', // Green
  4: '#06b6d4', // Cyan
  5: '#3b82f6', // Blue
  6: '#d946ef', // Magenta
  7: '#f8fafc', // White/Black
  8: '#64748b', // Gray
  9: '#94a3b8', // Light gray
  10: '#f43f5e',
  12: '#dc2626',
  20: '#fb7185',
  30: '#f97316',
  32: '#ea580c',
  40: '#f59e0b',
  42: '#d97706',
  50: '#facc15',
  60: '#a3e635',
  70: '#84cc16',
  80: '#4ade80',
  90: '#10b981',
  100: '#14b8a6',
  110: '#2dd4bf',
  120: '#06b6d4',
  130: '#0ea5e9',
  140: '#38bdf8',
  150: '#60a5fa',
  160: '#3b82f6',
  170: '#6366f1',
  180: '#818cf8',
  190: '#8b5cf6',
  200: '#a855f7',
  210: '#c084fc',
  220: '#e879f9',
  230: '#ec4899',
  240: '#f472b6',
};

export const DXF_DEFAULT_COLOR_PALETTE = [
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#38bdf8', // Sky
  '#f43f5e', // Rose
  '#a855f7', // Purple
  '#eab308', // Yellow
  '#06b6d4', // Cyan
  '#84cc16', // Lime
  '#f97316', // Orange
  '#ec4899', // Pink
];

function aciToHex(aci: number | undefined, fallbackIdx: number): string {
  if (aci !== undefined && Number.isFinite(aci)) {
    const abs = Math.abs(Math.round(aci));
    if (abs === 7) return '#f59e0b'; // White/neutral in CAD maps to high-contrast amber on dark/ortho
    if (ACI_HEX_PALETTE[abs]) return ACI_HEX_PALETTE[abs];
    if (abs > 0 && abs < 256) {
      const keys = Object.keys(ACI_HEX_PALETTE).map(Number);
      let closest = keys[0];
      let bestDiff = Infinity;
      for (const k of keys) {
        const diff = Math.abs(k - abs);
        if (diff < bestDiff) {
          bestDiff = diff;
          closest = k;
        }
      }
      return ACI_HEX_PALETTE[closest];
    }
  }
  return DXF_DEFAULT_COLOR_PALETTE[fallbackIdx % DXF_DEFAULT_COLOR_PALETTE.length];
}

interface RawTriangle {
  layer: string;
  color?: number;
  verts: [DxfPoint3D, DxfPoint3D, DxfPoint3D];
  centroid: DxfPoint3D;
}

interface RawTextLabel {
  layer: string;
  text: string;
  x: number;
  y: number;
  z: number;
}

interface RawPoly {
  layer: string;
  color?: number;
  closed: boolean;
  vertices: DxfPoint3D[];
}

function cleanDxfText(raw: string): string {
  return String(raw || '')
    .replace(/\\[PLp~]/g, ' ')
    .replace(/\{[^}]*;([^}]*)\}/g, '$1')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .trim();
}

function computePolygonArea2D(pts: DxfPoint3D[]): number {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

function computePerimeter3D(pts: DxfPoint3D[], closed: boolean): number {
  if (pts.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  if (closed && pts.length >= 3) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    total += Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z);
  }
  return total;
}

function isPointInPolygon2D(px: number, py: number, poly: DxfPoint3D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeConvexHull2D(points: DxfPoint3D[]): DxfPoint3D[] {
  if (points.length <= 3) return points;
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o: DxfPoint3D, a: DxfPoint3D, b: DxfPoint3D) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: DxfPoint3D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: DxfPoint3D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function deduplicateClosedVertices(pts: DxfPoint3D[]): DxfPoint3D[] {
  const out: DxfPoint3D[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (
      prev &&
      Math.abs(prev.x - p.x) < 1e-5 &&
      Math.abs(prev.y - p.y) < 1e-5 &&
      Math.abs(prev.z - p.z) < 1e-5
    ) {
      continue;
    }
    out.push(p);
  }
  if (out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.abs(first.x - last.x) < 1e-5 &&
      Math.abs(first.y - last.y) < 1e-5 &&
      Math.abs(first.z - last.z) < 1e-5
    ) {
      out.pop();
    }
  }
  return out;
}

function ocsToWcs(
  ox: number,
  oy: number,
  oz: number,
  nx: number,
  ny: number,
  nz: number
): DxfPoint3D {
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && Math.abs(nz - 1) < 1e-9) {
    return { x: ox, y: oy, z: oz };
  }
  const nLen = Math.hypot(nx, ny, nz) || 1;
  const N = [nx / nLen, ny / nLen, nz / nLen];
  // AutoCAD Arbitrary Axis Algorithm
  const useWorldY = Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64;
  const ref = useWorldY ? [0, 1, 0] : [0, 0, 1];
  const axRaw = [
    ref[1] * N[2] - ref[2] * N[1],
    ref[2] * N[0] - ref[0] * N[2],
    ref[0] * N[1] - ref[1] * N[0],
  ];
  const axLen = Math.hypot(axRaw[0], axRaw[1], axRaw[2]) || 1;
  const Ax = [axRaw[0] / axLen, axRaw[1] / axLen, axRaw[2] / axLen];
  const Ay = [
    N[1] * Ax[2] - N[2] * Ax[1],
    N[2] * Ax[0] - N[0] * Ax[2],
    N[0] * Ax[1] - N[1] * Ax[0],
  ];
  return {
    x: Ax[0] * ox + Ay[0] * oy + N[0] * oz,
    y: Ax[1] * ox + Ay[1] * oy + N[1] * oz,
    z: Ax[2] * ox + Ay[2] * oy + N[2] * oz,
  };
}

export interface ParsedDxfOverlayResult {
  polygons: DxfPolygonRegion[];
  surfaceCount: number;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
}

export function parseDxfOverlayText(dxfText: string): ParsedDxfOverlayResult {
  const normalized = String(dxfText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length < 4) {
    throw new Error('El archivo DXF está vacío o no tiene formato ASCII válido.');
  }

  // Pair group-code/value stream
  const pairs: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    pairs.push([code, lines[i + 1].trim()]);
  }

  const layerColors = new Map<string, number>();
  const rawPolys: RawPoly[] = [];
  const rawTriangles: RawTriangle[] = [];
  const rawLabels: RawTextLabel[] = [];

  interface BlockDef {
    name: string;
    base: DxfPoint3D;
    polys: RawPoly[];
    tris: RawTriangle[];
    labels: RawTextLabel[];
  }
  const blocks = new Map<string, BlockDef>();
  let curBlock: BlockDef | null = null;
  const pendingInserts: Array<{
    blockName: string;
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    sz: number;
    rotDeg: number;
    layer: string;
    color?: number;
  }> = [];

  let section = '';
  let inLayerTable = false;
  let curLayerName = '';
  let curLayerColor: number | undefined;

  let entityType = '';
  let curLayer = '0';
  let curColor: number | undefined;
  let curFlags = 0;
  let curElev = 0;
  let curExtrude: [number, number, number] = [0, 0, 1];

  // LWPOLYLINE state
  let lwVerts: DxfPoint3D[] = [];
  let lwPendingX: number | null = null;
  let lwPendingY: number | null = null;

  // POLYLINE + VERTEX state
  let inPolyline = false;
  let polyLayer = '0';
  let polyColor: number | undefined;
  let polyFlags = 0;
  let polyDefaultZ = 0;
  let polyMeshN = 0;
  let polyExtrude: [number, number, number] = [0, 0, 1];
  let polyVertices: DxfPoint3D[] = [];
  let polyMeshVerts: DxfPoint3D[] = [];
  let polyMeshFaces: Array<[number, number, number, number]> = [];

  let curVertexX = 0;
  let curVertexY = 0;
  let curVertexZ = 0;
  let curVertexFlags = 0;
  let curFaceIdx: [number, number, number, number] = [0, 0, 0, 0];

  // 3DFACE state
  let f3Pts: [DxfPoint3D, DxfPoint3D, DxfPoint3D, DxfPoint3D] = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ];

  // TEXT / MTEXT state
  let curTextStr = '';
  let curTextX = 0;
  let curTextY = 0;
  let curTextZ = 0;

  // INSERT state
  let curInsertName = '';
  let curInsertX = 0;
  let curInsertY = 0;
  let curInsertZ = 0;
  let curInsertSx = 1;
  let curInsertSy = 1;
  let curInsertSz = 1;
  let curInsertRot = 0;

  const targetPolys = () => (section === 'BLOCKS' && curBlock ? curBlock.polys : rawPolys);
  const targetTris = () => (section === 'BLOCKS' && curBlock ? curBlock.tris : rawTriangles);
  const targetLabels = () => (section === 'BLOCKS' && curBlock ? curBlock.labels : rawLabels);

  const pushTri = (layer: string, color: number | undefined, a: DxfPoint3D, b: DxfPoint3D, c: DxfPoint3D) => {
    targetTris().push({
      layer,
      color,
      verts: [a, b, c],
      centroid: {
        x: (a.x + b.x + c.x) / 3,
        y: (a.y + b.y + c.y) / 3,
        z: (a.z + b.z + c.z) / 3,
      },
    });
  };

  const flushEntity = () => {
    if (!entityType) return;

    if (entityType === 'LWPOLYLINE') {
      if (lwPendingX !== null && lwPendingY !== null) {
        lwVerts.push(ocsToWcs(lwPendingX, lwPendingY, curElev, curExtrude[0], curExtrude[1], curExtrude[2]));
      }
      const cleaned = deduplicateClosedVertices(lwVerts);
      if (cleaned.length >= 3) {
        targetPolys().push({
          layer: curLayer,
          color: curColor,
          closed: (curFlags & 1) === 1 || lwVerts.length > cleaned.length,
          vertices: cleaned,
        });
      }
    } else if (entityType === 'VERTEX' && inPolyline) {
      const isFaceIndex = (curVertexFlags & 128) === 128 && (curVertexFlags & 64) !== 64;
      if ((polyFlags & 64) === 64 && isFaceIndex) {
        polyMeshFaces.push([curFaceIdx[0], curFaceIdx[1], curFaceIdx[2], curFaceIdx[3]]);
      } else {
        const rawZ = Number.isFinite(curVertexZ) ? curVertexZ : polyDefaultZ;
        const is3dPoly = (polyFlags & 8) === 8 || (polyFlags & 16) === 16 || (polyFlags & 64) === 64;
        const pt: DxfPoint3D = is3dPoly
          ? { x: curVertexX, y: curVertexY, z: rawZ }
          : ocsToWcs(curVertexX, curVertexY, rawZ, polyExtrude[0], polyExtrude[1], polyExtrude[2]);
        if ((polyFlags & 64) === 64 || (polyFlags & 16) === 16) {
          polyMeshVerts.push(pt);
        } else {
          polyVertices.push(pt);
        }
      }
    } else if (entityType === '3DFACE') {
      const [p0, p1, p2, p3] = f3Pts;
      pushTri(curLayer, curColor, p0, p1, p2);
      const sameAsP2 =
        Math.abs(p3.x - p2.x) < 1e-6 &&
        Math.abs(p3.y - p2.y) < 1e-6 &&
        Math.abs(p3.z - p2.z) < 1e-6;
      const sameAsP0 =
        Math.abs(p3.x - p0.x) < 1e-6 &&
        Math.abs(p3.y - p0.y) < 1e-6 &&
        Math.abs(p3.z - p0.z) < 1e-6;
      if (!sameAsP2 && !sameAsP0) {
        pushTri(curLayer, curColor, p0, p2, p3);
      }
    } else if (entityType === 'TEXT' || entityType === 'MTEXT') {
      const clean = cleanDxfText(curTextStr);
      if (clean) {
        const pt = ocsToWcs(curTextX, curTextY, curTextZ, curExtrude[0], curExtrude[1], curExtrude[2]);
        targetLabels().push({
          layer: curLayer,
          text: clean,
          x: pt.x,
          y: pt.y,
          z: pt.z,
        });
      }
    } else if (entityType === 'INSERT' && section === 'ENTITIES' && curInsertName) {
      const wcsOrigin = ocsToWcs(
        curInsertX,
        curInsertY,
        curInsertZ,
        curExtrude[0],
        curExtrude[1],
        curExtrude[2]
      );
      pendingInserts.push({
        blockName: curInsertName,
        x: wcsOrigin.x,
        y: wcsOrigin.y,
        z: wcsOrigin.z,
        sx: Number.isFinite(curInsertSx) && curInsertSx !== 0 ? curInsertSx : 1,
        sy: Number.isFinite(curInsertSy) && curInsertSy !== 0 ? curInsertSy : 1,
        sz: Number.isFinite(curInsertSz) && curInsertSz !== 0 ? curInsertSz : 1,
        rotDeg: Number.isFinite(curInsertRot) ? curInsertRot : 0,
        layer: curLayer,
        color: curColor,
      });
    }

    entityType = '';
  };

  const flushPolyline = () => {
    if (!inPolyline) return;
    if ((polyFlags & 64) === 64) {
      for (const face of polyMeshFaces) {
        const idxList = face.map((v) => Math.abs(v) - 1).filter((idx) => idx >= 0 && idx < polyMeshVerts.length);
        if (idxList.length >= 3) {
          pushTri(
            polyLayer,
            polyColor,
            polyMeshVerts[idxList[0]],
            polyMeshVerts[idxList[1]],
            polyMeshVerts[idxList[2]]
          );
          if (idxList.length >= 4 && idxList[3] !== idxList[2] && idxList[3] !== idxList[0]) {
            pushTri(
              polyLayer,
              polyColor,
              polyMeshVerts[idxList[0]],
              polyMeshVerts[idxList[2]],
              polyMeshVerts[idxList[3]]
            );
          }
        }
      }
    } else if ((polyFlags & 16) === 16 && polyMeshN >= 2 && polyMeshVerts.length >= 4) {
      const n = polyMeshN;
      const m = Math.floor(polyMeshVerts.length / n);
      for (let r = 0; r < m - 1; r++) {
        for (let c = 0; c < n - 1; c++) {
          const a = polyMeshVerts[r * n + c];
          const b = polyMeshVerts[r * n + c + 1];
          const d = polyMeshVerts[(r + 1) * n + c];
          const e = polyMeshVerts[(r + 1) * n + c + 1];
          pushTri(polyLayer, polyColor, a, b, e);
          pushTri(polyLayer, polyColor, a, e, d);
        }
      }
    } else {
      const cleaned = deduplicateClosedVertices(polyVertices);
      if (cleaned.length >= 3) {
        targetPolys().push({
          layer: polyLayer,
          color: polyColor,
          closed: (polyFlags & 1) === 1 || polyVertices.length > cleaned.length,
          vertices: cleaned,
        });
      }
    }
    inPolyline = false;
    polyVertices = [];
    polyMeshVerts = [];
    polyMeshFaces = [];
  };

  for (let i = 0; i < pairs.length; i++) {
    const [code, val] = pairs[i];

    if (code === 0) {
      if (val === 'SECTION') {
        flushEntity();
        flushPolyline();
        curBlock = null;
        if (i + 1 < pairs.length && pairs[i + 1][0] === 2) {
          section = pairs[i + 1][1].toUpperCase();
        }
        continue;
      }
      if (val === 'ENDSEC' || val === 'EOF') {
        flushEntity();
        flushPolyline();
        if (curBlock && curBlock.name) {
          blocks.set(curBlock.name, curBlock);
        }
        curBlock = null;
        inLayerTable = false;
        section = '';
        continue;
      }

      if (section === 'TABLES') {
        if (val === 'TABLE' && i + 1 < pairs.length && pairs[i + 1][0] === 2) {
          inLayerTable = pairs[i + 1][1].toUpperCase() === 'LAYER';
          continue;
        }
        if (val === 'ENDTAB') {
          if (inLayerTable && curLayerName) {
            if (curLayerColor !== undefined) layerColors.set(curLayerName, curLayerColor);
            curLayerName = '';
            curLayerColor = undefined;
          }
          inLayerTable = false;
          continue;
        }
        if (inLayerTable && val === 'LAYER') {
          if (curLayerName && curLayerColor !== undefined) {
            layerColors.set(curLayerName, curLayerColor);
          }
          curLayerName = '';
          curLayerColor = undefined;
          continue;
        }
      }

      if (section === 'BLOCKS') {
        if (val === 'BLOCK') {
          flushEntity();
          flushPolyline();
          curBlock = { name: '', base: { x: 0, y: 0, z: 0 }, polys: [], tris: [], labels: [] };
          entityType = 'BLOCK_HEADER';
          continue;
        }
        if (val === 'ENDBLK') {
          flushEntity();
          flushPolyline();
          if (curBlock && curBlock.name) {
            blocks.set(curBlock.name, curBlock);
          }
          curBlock = null;
          entityType = '';
          continue;
        }
      }

      if (section === 'ENTITIES' || (section === 'BLOCKS' && curBlock !== null)) {
        flushEntity();
        if (val === 'SEQEND') {
          flushPolyline();
          continue;
        }
        if (val === 'POLYLINE') {
          flushPolyline();
          inPolyline = true;
          polyLayer = '0';
          polyColor = undefined;
          polyFlags = 0;
          polyDefaultZ = 0;
          polyMeshN = 0;
          polyExtrude = [0, 0, 1];
          polyVertices = [];
          polyMeshVerts = [];
          polyMeshFaces = [];
          entityType = 'POLYLINE';
          continue;
        }

        entityType = val.toUpperCase();
        curLayer = '0';
        curColor = undefined;
        curFlags = 0;
        curElev = 0;
        curExtrude = [0, 0, 1];
        lwVerts = [];
        lwPendingX = null;
        lwPendingY = null;
        curVertexX = 0;
        curVertexY = 0;
        curVertexZ = polyDefaultZ;
        curVertexFlags = 0;
        curFaceIdx = [0, 0, 0, 0];
        f3Pts = [
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
        ];
        curTextStr = '';
        curTextX = 0;
        curTextY = 0;
        curTextZ = 0;
        curInsertName = '';
        curInsertX = 0;
        curInsertY = 0;
        curInsertZ = 0;
        curInsertSx = 1;
        curInsertSy = 1;
        curInsertSz = 1;
        curInsertRot = 0;
        continue;
      }
    }

    if (section === 'TABLES' && inLayerTable) {
      if (code === 2) curLayerName = val;
      else if (code === 62) {
        const c = parseInt(val, 10);
        if (Number.isFinite(c)) curLayerColor = Math.abs(c);
      }
      continue;
    }

    if (section === 'BLOCKS' && entityType === 'BLOCK_HEADER' && curBlock) {
      if (code === 2) curBlock.name = val;
      else if (code === 10) curBlock.base.x = parseFloat(val) || 0;
      else if (code === 20) curBlock.base.y = parseFloat(val) || 0;
      else if (code === 30) curBlock.base.z = parseFloat(val) || 0;
      continue;
    }

    if (section !== 'ENTITIES' && !(section === 'BLOCKS' && curBlock !== null)) continue;

    if (entityType === 'POLYLINE') {
      if (code === 8) polyLayer = val || '0';
      else if (code === 62) {
        const c = parseInt(val, 10);
        if (Number.isFinite(c)) polyColor = Math.abs(c);
      } else if (code === 70) polyFlags = parseInt(val, 10) || 0;
      else if (code === 72) polyMeshN = parseInt(val, 10) || 0;
      else if (code === 30) polyDefaultZ = parseFloat(val) || 0;
      else if (code === 210) polyExtrude[0] = parseFloat(val) || 0;
      else if (code === 220) polyExtrude[1] = parseFloat(val) || 0;
      else if (code === 230) polyExtrude[2] = parseFloat(val) || 1;
      continue;
    }

    if (entityType === 'VERTEX') {
      if (code === 10) curVertexX = parseFloat(val) || 0;
      else if (code === 20) curVertexY = parseFloat(val) || 0;
      else if (code === 30) curVertexZ = parseFloat(val) || 0;
      else if (code === 70) curVertexFlags = parseInt(val, 10) || 0;
      else if (code === 71) curFaceIdx[0] = parseInt(val, 10) || 0;
      else if (code === 72) curFaceIdx[1] = parseInt(val, 10) || 0;
      else if (code === 73) curFaceIdx[2] = parseInt(val, 10) || 0;
      else if (code === 74) curFaceIdx[3] = parseInt(val, 10) || 0;
      continue;
    }

    if (entityType === 'LWPOLYLINE') {
      if (code === 8) curLayer = val || '0';
      else if (code === 62) {
        const c = parseInt(val, 10);
        if (Number.isFinite(c)) curColor = Math.abs(c);
      } else if (code === 70) curFlags = parseInt(val, 10) || 0;
      else if (code === 38) curElev = parseFloat(val) || 0;
      else if (code === 210) curExtrude[0] = parseFloat(val) || 0;
      else if (code === 220) curExtrude[1] = parseFloat(val) || 0;
      else if (code === 230) curExtrude[2] = parseFloat(val) || 1;
      else if (code === 10) {
        if (lwPendingX !== null && lwPendingY !== null) {
          lwVerts.push(ocsToWcs(lwPendingX, lwPendingY, curElev, curExtrude[0], curExtrude[1], curExtrude[2]));
        }
        lwPendingX = parseFloat(val) || 0;
        lwPendingY = null;
      } else if (code === 20) {
        lwPendingY = parseFloat(val) || 0;
        if (lwPendingX !== null) {
          lwVerts.push(ocsToWcs(lwPendingX, lwPendingY, curElev, curExtrude[0], curExtrude[1], curExtrude[2]));
          lwPendingX = null;
          lwPendingY = null;
        }
      }
      continue;
    }

    if (entityType === '3DFACE') {
      if (code === 8) curLayer = val || '0';
      else if (code === 62) {
        const c = parseInt(val, 10);
        if (Number.isFinite(c)) curColor = Math.abs(c);
      } else if (code === 10) f3Pts[0].x = parseFloat(val) || 0;
      else if (code === 20) f3Pts[0].y = parseFloat(val) || 0;
      else if (code === 30) f3Pts[0].z = parseFloat(val) || 0;
      else if (code === 11) f3Pts[1].x = parseFloat(val) || 0;
      else if (code === 21) f3Pts[1].y = parseFloat(val) || 0;
      else if (code === 31) f3Pts[1].z = parseFloat(val) || 0;
      else if (code === 12) f3Pts[2].x = parseFloat(val) || 0;
      else if (code === 22) f3Pts[2].y = parseFloat(val) || 0;
      else if (code === 32) f3Pts[2].z = parseFloat(val) || 0;
      else if (code === 13) f3Pts[3].x = parseFloat(val) || 0;
      else if (code === 23) f3Pts[3].y = parseFloat(val) || 0;
      else if (code === 33) f3Pts[3].z = parseFloat(val) || 0;
      continue;
    }

    if (entityType === 'TEXT' || entityType === 'MTEXT') {
      if (code === 8) curLayer = val || '0';
      else if (code === 1 || code === 3) curTextStr += val;
      else if (code === 10) curTextX = parseFloat(val) || 0;
      else if (code === 20) curTextY = parseFloat(val) || 0;
      else if (code === 30) curTextZ = parseFloat(val) || 0;
      else if (code === 210) curExtrude[0] = parseFloat(val) || 0;
      else if (code === 220) curExtrude[1] = parseFloat(val) || 0;
      else if (code === 230) curExtrude[2] = parseFloat(val) || 1;
      continue;
    }

    if (entityType === 'INSERT') {
      if (code === 8) curLayer = val || '0';
      else if (code === 62) {
        const c = parseInt(val, 10);
        if (Number.isFinite(c)) curColor = Math.abs(c);
      } else if (code === 2) curInsertName = val;
      else if (code === 10) curInsertX = parseFloat(val) || 0;
      else if (code === 20) curInsertY = parseFloat(val) || 0;
      else if (code === 30) curInsertZ = parseFloat(val) || 0;
      else if (code === 41) curInsertSx = parseFloat(val) || 1;
      else if (code === 42) curInsertSy = parseFloat(val) || 1;
      else if (code === 43) curInsertSz = parseFloat(val) || 1;
      else if (code === 50) curInsertRot = parseFloat(val) || 0;
      else if (code === 210) curExtrude[0] = parseFloat(val) || 0;
      else if (code === 220) curExtrude[1] = parseFloat(val) || 0;
      else if (code === 230) curExtrude[2] = parseFloat(val) || 1;
    }
  }

  flushEntity();
  flushPolyline();

  // Expand INSERT references from ENTITIES using block definitions
  for (const ins of pendingInserts) {
    const blk = blocks.get(ins.blockName);
    if (!blk) continue;
    const rad = (ins.rotDeg * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);
    const xformPt = (pt: DxfPoint3D): DxfPoint3D => {
      const lx = (pt.x - blk.base.x) * ins.sx;
      const ly = (pt.y - blk.base.y) * ins.sy;
      const lz = (pt.z - blk.base.z) * ins.sz;
      return {
        x: ins.x + lx * cosR - ly * sinR,
        y: ins.y + lx * sinR + ly * cosR,
        z: ins.z + lz,
      };
    };
    for (const p of blk.polys) {
      rawPolys.push({
        layer: p.layer === '0' ? ins.layer : p.layer,
        color: p.color ?? ins.color,
        closed: p.closed,
        vertices: p.vertices.map(xformPt),
      });
    }
    for (const t of blk.tris) {
      const a = xformPt(t.verts[0]);
      const b = xformPt(t.verts[1]);
      const c = xformPt(t.verts[2]);
      rawTriangles.push({
        layer: t.layer === '0' ? ins.layer : t.layer,
        color: t.color ?? ins.color,
        verts: [a, b, c],
        centroid: {
          x: (a.x + b.x + c.x) / 3,
          y: (a.y + b.y + c.y) / 3,
          z: (a.z + b.z + c.z) / 3,
        },
      });
    }
    for (const lbl of blk.labels) {
      const p = xformPt({ x: lbl.x, y: lbl.y, z: lbl.z });
      rawLabels.push({
        layer: lbl.layer === '0' ? ins.layer : lbl.layer,
        text: lbl.text,
        x: p.x,
        y: p.y,
        z: p.z,
      });
    }
  }

  // Only fall back to non-system BLOCKS if ENTITIES & INSERTs yielded nothing
  if (rawPolys.length === 0 && rawTriangles.length === 0) {
    for (const blk of blocks.values()) {
      if (blk.name.startsWith('*')) continue;
      rawPolys.push(...blk.polys);
      rawTriangles.push(...blk.tris);
      rawLabels.push(...blk.labels);
    }
  }

  // If DXF has 3D faces/surfaces grouped by layer without explicit boundary polylines,
  // derive an outer perimeter convex hull per layer so every 3D surface zone is assignable.
  if (rawPolys.length === 0 && rawTriangles.length > 0) {
    const trisByLayer = new Map<string, RawTriangle[]>();
    for (const tri of rawTriangles) {
      const list = trisByLayer.get(tri.layer) || [];
      list.push(tri);
      trisByLayer.set(tri.layer, list);
    }
    for (const [layer, tris] of trisByLayer.entries()) {
      const allPts = tris.flatMap((t) => t.verts);
      const hull = computeConvexHull2D(allPts);
      if (hull.length >= 3) {
        rawPolys.push({
          layer,
          color: tris.find((t) => t.color !== undefined)?.color,
          closed: true,
          vertices: hull,
        });
      }
    }
  }

  if (rawPolys.length === 0) {
    throw new Error(
      'No se detectaron polígonos 3D ni superficies cerradas (POLYLINE / LWPOLYLINE / 3DFACE) en el archivo DXF.'
    );
  }

  const polygons: DxfPolygonRegion[] = rawPolys.map((poly, idx) => {
    const verts = poly.vertices;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const v of verts) {
      sumX += v.x;
      sumY += v.y;
      sumZ += v.z;
      if (v.z < minZ) minZ = v.z;
      if (v.z > maxZ) maxZ = v.z;
    }
    const n = verts.length;
    const centroid: DxfPoint3D = { x: sumX / n, y: sumY / n, z: sumZ / n };
    const aci = poly.color ?? layerColors.get(poly.layer);
    const color = aciToHex(aci, idx);

    // Match 3D surface triangles inside this polygon
    const insideTris = rawTriangles.filter((tri) =>
      isPointInPolygon2D(tri.centroid.x, tri.centroid.y, verts)
    );
    const layerFallbackTris =
      insideTris.length > 0
        ? insideTris
        : rawTriangles.filter((tri) => tri.layer === poly.layer);

    for (const tri of layerFallbackTris) {
      for (const tv of tri.verts) {
        if (tv.z < minZ) minZ = tv.z;
        if (tv.z > maxZ) maxZ = tv.z;
      }
    }

    // Check if an explicit CAD TEXT/MTEXT label falls inside the polygon
    const matchedText = rawLabels.find((lbl) => isPointInPolygon2D(lbl.x, lbl.y, verts));
    const layerSuffix = poly.layer && poly.layer !== '0' ? ` · ${poly.layer}` : '';
    const defaultLabel = matchedText?.text
      ? matchedText.text.slice(0, 48)
      : `Polígono ${String(idx + 1).padStart(2, '0')}${layerSuffix}`;

    const safeMinZ = Number.isFinite(minZ) ? minZ : 0;
    const safeMaxZ = Number.isFinite(maxZ) ? maxZ : safeMinZ;
    const meanZ =
      layerFallbackTris.length > 0
        ? layerFallbackTris.reduce((acc, t) => acc + t.centroid.z, 0) / layerFallbackTris.length
        : centroid.z;

    return {
      id: `dxf-poly-${idx + 1}`,
      index: idx + 1,
      layer: poly.layer || '0',
      label: defaultLabel,
      color,
      closed: poly.closed,
      vertices: verts,
      surfaceTriangles:
        layerFallbackTris.length > 0 ? layerFallbackTris.map((t) => t.verts) : undefined,
      areaM2: Math.round(computePolygonArea2D(verts) * 100) / 100,
      perimeterM: Math.round(computePerimeter3D(verts, poly.closed) * 100) / 100,
      centroid: {
        x: Math.round(centroid.x * 1000) / 1000,
        y: Math.round(centroid.y * 1000) / 1000,
        z: Math.round(meanZ * 1000) / 1000,
      },
      minZ: Math.round(safeMinZ * 1000) / 1000,
      maxZ: Math.round(safeMaxZ * 1000) / 1000,
      meanZ: Math.round(meanZ * 1000) / 1000,
      stockpileId: null,
      visible: true,
    };
  });

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const expand = (p: DxfPoint3D) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  };

  for (const p of polygons) {
    p.vertices.forEach(expand);
    p.surfaceTriangles?.forEach((tri) => tri.forEach(expand));
  }

  return {
    polygons,
    surfaceCount: rawTriangles.length,
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
      minZ: Number.isFinite(minZ) ? minZ : 0,
      maxZ: Number.isFinite(maxZ) ? maxZ : 0,
    },
  };
}

export function autoMatchDxfPolygonsToStockpiles(
  polygons: DxfPolygonRegion[],
  stockpiles: Array<Pick<Stockpile, 'id' | 'code' | 'name' | 'material'>>
): DxfPolygonRegion[] {
  if (!stockpiles || stockpiles.length === 0) return polygons;
  const usedStockpileIds = new Set<number>();

  return polygons.map((poly) => {
    if (poly.stockpileId && stockpiles.some((s) => s.id === poly.stockpileId)) {
      usedStockpileIds.add(poly.stockpileId);
      return poly;
    }

    const searchHay = `${poly.label} ${poly.layer}`.toLowerCase();
    const matched = stockpiles.find((st) => {
      const code = st.code.trim().toLowerCase();
      const name = st.name.trim().toLowerCase();
      return (
        (code && searchHay.includes(code)) ||
        (name && name.length >= 4 && searchHay.includes(name))
      );
    });

    if (matched) {
      usedStockpileIds.add(matched.id);
      return { ...poly, stockpileId: matched.id };
    }
    return poly;
  });
}

export interface DxfCadTransformContext {
  sourceOrigin: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  boxMinY: number;
  scaleFactor: number;
  zUp: boolean;
  cadMin: { x: number; y: number; z: number };
  cadMax: { x: number; y: number; z: number };
}

export interface DxfWorldMappingOptions {
  terrainOriginUtm: { e0: number; n0: number };
  terrainSpanM: number;
  terrainHalfM: number;
  demElevMinM: number;
  demElevMaxM: number;
  cadTransform?: DxfCadTransformContext | null;
  hasExternal3D?: boolean;
  externalHeightSpan?: number;
  viewerZMinM?: number;
  viewerZMaxM?: number;
  planWorldBounds?: {
    minE: number;
    maxE: number;
    minN: number;
    maxN: number;
    spanE: number;
    spanN: number;
  } | null;
}

export interface DxfWorldMapper {
  mode: 'external_cad' | 'utm_exact' | 'centered_fit';
  mapPoint: (pt: DxfPoint3D) => { worldX: number; baseY: number; worldZ: number };
}

export function createDxfWorldMapper(
  overlay: FlightDxfOverlay,
  opts: DxfWorldMappingOptions
): DxfWorldMapper {
  const { bounds } = overlay;
  const spanX = Math.max(1e-4, bounds.maxX - bounds.minX);
  const spanY = Math.max(1e-4, bounds.maxY - bounds.minY);
  const spanZ = Math.max(0.01, bounds.maxZ - bounds.minZ);
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cy = (bounds.minY + bounds.maxY) * 0.5;

  // 0. Map directly onto loaded 2D plan coordinate bounds when provided
  if (opts.planWorldBounds) {
    const pb = opts.planWorldBounds;
    const pbSpanE = Math.max(1e-4, pb.maxE - pb.minE);
    const pbSpanN = Math.max(1e-4, pb.maxN - pb.minN);
    const pbCenterE = (pb.minE + pb.maxE) * 0.5;
    const pbCenterN = (pb.minN + pb.maxN) * 0.5;
    const marginE = Math.max(150, Math.max(pbSpanE, spanX) * 0.75);
    const marginN = Math.max(150, Math.max(pbSpanN, spanY) * 0.75);
    const overlapsPlan =
      bounds.maxX >= pb.minE - marginE &&
      bounds.minX <= pb.maxE + marginE &&
      bounds.maxY >= pb.minN - marginN &&
      bounds.minY <= pb.maxN + marginN;

    if (overlapsPlan) {
      const zMin = opts.demElevMinM;
      const zSpan = Math.max(0.01, opts.demElevMaxM - opts.demElevMinM);
      return {
        mode: 'utm_exact',
        mapPoint: (pt: DxfPoint3D) => ({
          worldX: ((pt.x - pbCenterE) / pbSpanE) * pb.spanE,
          baseY: ((pt.z - zMin) / zSpan) * 40,
          worldZ: -((pt.y - pbCenterN) / pbSpanN) * pb.spanN,
        }),
      };
    }
  }

  // 1. Align directly to loaded External 3D model when CAD bounds overlap
  if (opts.hasExternal3D && opts.cadTransform) {
    const ct = opts.cadTransform;
    const margin = Math.max(50, Math.max(ct.cadMax.x - ct.cadMin.x, ct.cadMax.y - ct.cadMin.y) * 0.35);
    const overlapsExternal =
      bounds.maxX >= ct.cadMin.x - margin &&
      bounds.minX <= ct.cadMax.x + margin &&
      bounds.maxY >= ct.cadMin.y - margin &&
      bounds.minY <= ct.cadMax.y + margin;

    if (overlapsExternal) {
      return {
        mode: 'external_cad',
        mapPoint: (pt: DxfPoint3D) => {
          const lx = pt.x - ct.sourceOrigin.x;
          const ly = pt.y - ct.sourceOrigin.y;
          const lz = pt.z - ct.sourceOrigin.z;
          if (ct.zUp) {
            // Mirror rotation(-PI/2 around X): (x, y, z) -> (x, z, -y)
            return {
              worldX: (lx - ct.center.x) * ct.scaleFactor,
              baseY: (lz - ct.boxMinY) * ct.scaleFactor,
              worldZ: (-ly - ct.center.z) * ct.scaleFactor,
            };
          }
          return {
            worldX: (lx - ct.center.x) * ct.scaleFactor,
            baseY: (ly - ct.boxMinY) * ct.scaleFactor,
            worldZ: (lz - ct.center.z) * ct.scaleFactor,
          };
        },
      };
    }
  }

  // 2. Check if DXF coordinates lie inside the UTM 400x400m terrain frame
  const { e0, n0 } = opts.terrainOriginUtm;
  const utmPad = 80;
  const overlapsUtm =
    !opts.hasExternal3D &&
    bounds.maxX >= e0 - utmPad &&
    bounds.minX <= e0 + opts.terrainSpanM + utmPad &&
    bounds.maxY >= n0 - utmPad &&
    bounds.minY <= n0 + opts.terrainSpanM + utmPad;

  const visSpan = opts.hasExternal3D
    ? Math.max(1e-4, opts.externalHeightSpan ?? 40)
    : opts.demElevMaxM - opts.demElevMinM <= 90
      ? Math.max(10, opts.demElevMaxM - opts.demElevMinM)
      : 90 + (opts.demElevMaxM - opts.demElevMinM - 90) * (50 / 910);

  if (overlapsUtm) {
    const zMin = opts.demElevMinM;
    const zSpan = Math.max(0.01, opts.demElevMaxM - opts.demElevMinM);
    return {
      mode: 'utm_exact',
      mapPoint: (pt: DxfPoint3D) => ({
        worldX: pt.x - e0 - opts.terrainHalfM,
        baseY: ((pt.z - zMin) / zSpan) * visSpan,
        worldZ: -(pt.y - n0 - opts.terrainHalfM),
      }),
    };
  }

  // 3. Center & fit DXF cleanly onto the 400x400m quarry canvas
  const maxSpan = Math.max(spanX, spanY);
  const fitScale =
    maxSpan <= opts.terrainSpanM * 0.88 ? 1 : (opts.terrainSpanM * 0.84) / maxSpan;

  const dxfElevFloor = bounds.minZ;
  const targetHeightSpan = Math.min(visSpan * 0.55, Math.max(10, spanZ * fitScale));
  const baseElevationLift = visSpan * 0.14;

  return {
    mode: 'centered_fit',
    mapPoint: (pt: DxfPoint3D) => ({
      worldX: (pt.x - cx) * fitScale,
      baseY: baseElevationLift + ((pt.z - dxfElevFloor) / spanZ) * targetHeightSpan,
      worldZ: -(pt.y - cy) * fitScale,
    }),
  };
}
