import * as THREE from 'three';
import { TERRAIN_SPAN_M } from './quarryTerrainModel.ts';
import type { CadTransform, PlanCoordinateBounds } from './threeFileLoader.ts';

export interface DxfContourPoint {
  x: number;
  y: number;
  z: number;
}

export interface DxfContourPolyline {
  points: DxfContourPoint[];
  closed: boolean;
  layer: string;
  elevation: number;
  isMaster: boolean;
  color: string;
}

export interface ParsedDxfContours {
  fileName: string;
  polylines: DxfContourPolyline[];
  segmentCount: number;
  vertexCount: number;
  layers: string[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
  };
  planBounds: PlanCoordinateBounds | null;
}

export function isSupportedContourDxfFileName(fileName: string): boolean {
  const clean = fileName.split('?')[0].toLowerCase().trim();
  return clean.endsWith('.dxf');
}

const ACI_HEX_PALETTE: Record<number, string> = {
  1: '#ef4444',
  2: '#eab308',
  3: '#22c55e',
  4: '#06b6d4',
  5: '#3b82f6',
  6: '#d946ef',
  7: '#f8fafc',
  8: '#64748b',
  9: '#94a3b8',
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

function aciToContourHex(aci: number | undefined, isMaster: boolean): string {
  if (aci !== undefined && Number.isFinite(aci)) {
    const abs = Math.abs(Math.round(aci));
    if (abs >= 1 && abs <= 255) {
      if (abs === 7) return isMaster ? '#fef08a' : '#f59e0b';
      if (ACI_HEX_PALETTE[abs]) return ACI_HEX_PALETTE[abs];
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
  return isMaster ? '#fef08a' : '#f59e0b';
}

interface DxfPair {
  code: number;
  value: string;
}

interface RawContourEntity {
  layer: string;
  aci?: number;
  closed: boolean;
  points: DxfContourPoint[];
  avgZ: number;
}

interface ContourBlockDef {
  name: string;
  base: DxfContourPoint;
  entities: RawContourEntity[];
}

interface ContourInsertRef {
  blockName: string;
  layer: string;
  aci?: number;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  rotDeg: number;
}

/** AutoCAD Arbitrary Axis Algorithm: converts Object Coordinate System (OCS) point to WCS */
function ocsToWcs(
  ox: number,
  oy: number,
  oz: number,
  nx: number,
  ny: number,
  nz: number
): DxfContourPoint {
  if (Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6 && Math.abs(nz - 1) < 1e-6) {
    return { x: ox, y: oy, z: oz };
  }
  const nLen = Math.hypot(nx, ny, nz) || 1;
  const azx = nx / nLen;
  const azy = ny / nLen;
  const azz = nz / nLen;

  let axx: number;
  let axy: number;
  let axz: number;
  if (Math.abs(azx) < 1 / 64 && Math.abs(azy) < 1 / 64) {
    // Wy x Az -> (azz, 0, -azx)
    axx = azz;
    axy = 0;
    axz = -azx;
  } else {
    // Wz x Az -> (-azy, azx, 0)
    axx = -azy;
    axy = azx;
    axz = 0;
  }
  const axLen = Math.hypot(axx, axy, axz) || 1;
  axx /= axLen;
  axy /= axLen;
  axz /= axLen;

  const ayx = azy * axz - azz * axy;
  const ayy = azz * axx - azx * axz;
  const ayz = azx * axy - azy * axx;

  return {
    x: ox * axx + oy * ayx + oz * azx,
    y: ox * axy + oy * ayy + oz * azy,
    z: ox * axz + oy * ayz + oz * azz,
  };
}

function tokenizeDxfPairs(dxfText: string): DxfPair[] {
  const cleanText = dxfText.replace(/^\uFEFF/, '');
  if (cleanText.slice(0, 32).includes('AutoCAD Binary DXF')) {
    throw new Error(
      'El archivo DXF está en formato binario (AutoCAD Binary DXF). Expórtalo como DXF ASCII desde AutoCAD, Civil 3D o QGIS.'
    );
  }
  const lines = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const pairs: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (!Number.isFinite(code)) continue;
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

function parseLayerAciColors(pairs: DxfPair[]): Map<string, number> {
  const layerColors = new Map<string, number>();
  let inTables = false;
  let inLayerTable = false;
  let inLayerRecord = false;
  let layerName = '';
  let layerAci: number | undefined;

  const commitLayer = () => {
    if (layerName && layerAci !== undefined && Number.isFinite(layerAci) && layerAci !== 0) {
      layerColors.set(layerName.toLowerCase(), Math.abs(Math.round(layerAci)));
    }
    layerName = '';
    layerAci = undefined;
  };

  for (let i = 0; i < pairs.length; i++) {
    const { code, value } = pairs[i];
    if (code === 0 && value === 'SECTION') {
      const next = pairs[i + 1];
      if (next?.code === 2 && next.value.toUpperCase() === 'TABLES') {
        inTables = true;
      }
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      commitLayer();
      if (inTables) break;
      inTables = false;
      inLayerTable = false;
      inLayerRecord = false;
      continue;
    }
    if (!inTables) continue;

    if (code === 0 && value === 'TABLE') {
      const next = pairs[i + 1];
      inLayerTable = next?.code === 2 && next.value.toUpperCase() === 'LAYER';
      continue;
    }
    if (code === 0 && value === 'ENDTAB') {
      commitLayer();
      inLayerTable = false;
      inLayerRecord = false;
      continue;
    }
    if (!inLayerTable) continue;

    if (code === 0 && value === 'LAYER') {
      commitLayer();
      inLayerRecord = true;
      continue;
    }
    if (!inLayerRecord) continue;

    if (code === 2) {
      layerName = value;
    } else if (code === 62) {
      const n = parseInt(value, 10);
      if (Number.isFinite(n)) layerAci = n;
    }
  }
  return layerColors;
}

function extractContoursAndBlocks(pairs: DxfPair[]): {
  entities: RawContourEntity[];
  blocks: Map<string, ContourBlockDef>;
  inserts: ContourInsertRef[];
} {
  const entities: RawContourEntity[] = [];
  const blocks = new Map<string, ContourBlockDef>();
  const inserts: ContourInsertRef[] = [];

  let activeSection: '' | 'ENTITIES' | 'BLOCKS' = '';
  let curBlock: ContourBlockDef | null = null;
  let idx = 0;

  const pushEntity = (ent: RawContourEntity) => {
    if (activeSection === 'BLOCKS' && curBlock) {
      curBlock.entities.push(ent);
    } else if (activeSection === 'ENTITIES') {
      entities.push(ent);
    }
  };

  while (idx < pairs.length) {
    const p = pairs[idx];
    if (p.code === 0 && p.value === 'SECTION') {
      const secName = pairs[idx + 1]?.code === 2 ? pairs[idx + 1].value.toUpperCase() : '';
      activeSection = secName === 'ENTITIES' ? 'ENTITIES' : secName === 'BLOCKS' ? 'BLOCKS' : '';
      curBlock = null;
      idx += 2;
      continue;
    }
    if (p.code === 0 && p.value === 'ENDSEC') {
      if (curBlock && curBlock.name) {
        blocks.set(curBlock.name, curBlock);
      }
      curBlock = null;
      activeSection = '';
      idx += 1;
      continue;
    }
    if (!activeSection) {
      idx += 1;
      continue;
    }

    if (p.code !== 0) {
      idx += 1;
      continue;
    }

    const entityType = p.value.toUpperCase();
    idx += 1;

    if (activeSection === 'BLOCKS' && entityType === 'BLOCK') {
      let name = '';
      let bx = 0;
      let by = 0;
      let bz = 0;
      while (idx < pairs.length && pairs[idx].code !== 0) {
        const { code, value } = pairs[idx];
        if (code === 2) name = value;
        else if (code === 10) bx = parseFloat(value) || 0;
        else if (code === 20) by = parseFloat(value) || 0;
        else if (code === 30) bz = parseFloat(value) || 0;
        idx += 1;
      }
      curBlock = { name, base: { x: bx, y: by, z: bz }, entities: [] };
      continue;
    }

    if (activeSection === 'BLOCKS' && entityType === 'ENDBLK') {
      if (curBlock && curBlock.name) {
        blocks.set(curBlock.name, curBlock);
      }
      curBlock = null;
      while (idx < pairs.length && pairs[idx].code !== 0) {
        idx += 1;
      }
      continue;
    }

    if (activeSection === 'BLOCKS' && !curBlock) {
      while (idx < pairs.length && pairs[idx].code !== 0) {
        idx += 1;
      }
      continue;
    }

    if (entityType === 'LWPOLYLINE') {
      let layer = '0';
      let aci: number | undefined;
      let flags = 0;
      let constElev = 0;
      let nx = 0;
      let ny = 0;
      let nz = 1;
      const rawPts: Array<{ x: number; y: number; z?: number }> = [];
      let curX: number | null = null;
      let curY: number | null = null;
      let curZ: number | undefined;

      const flushVertex = () => {
        if (curX !== null && curY !== null && Number.isFinite(curX) && Number.isFinite(curY)) {
          rawPts.push({ x: curX, y: curY, z: curZ });
        }
        curX = null;
        curY = null;
        curZ = undefined;
      };

      while (idx < pairs.length && pairs[idx].code !== 0) {
        const { code, value } = pairs[idx];
        if (code === 8) layer = value || '0';
        else if (code === 62) {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) aci = n;
        } else if (code === 70) {
          flags = parseInt(value, 10) || 0;
        } else if (code === 38) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) constElev = n;
        } else if (code === 210) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) nx = n;
        } else if (code === 220) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) ny = n;
        } else if (code === 230) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) nz = n;
        } else if (code === 10) {
          flushVertex();
          const n = parseFloat(value);
          if (Number.isFinite(n)) curX = n;
        } else if (code === 20) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) curY = n;
        } else if (code === 30) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) curZ = n;
        }
        idx += 1;
      }
      flushVertex();

      if (rawPts.length >= 2) {
        const points = rawPts.map((pt) => {
          const elev = pt.z !== undefined && Number.isFinite(pt.z) ? pt.z : constElev;
          return ocsToWcs(pt.x, pt.y, elev, nx, ny, nz);
        });
        const avgZ = points.reduce((acc, pt) => acc + pt.z, 0) / points.length;
        pushEntity({
          layer,
          aci,
          closed: (flags & 1) === 1,
          points,
          avgZ,
        });
      }
      continue;
    }

    if (entityType === 'POLYLINE') {
      let layer = '0';
      let aci: number | undefined;
      let flags = 0;
      let defaultZ = 0;
      let nx = 0;
      let ny = 0;
      let nz = 1;

      while (idx < pairs.length && pairs[idx].code !== 0) {
        const { code, value } = pairs[idx];
        if (code === 8) layer = value || '0';
        else if (code === 62) {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) aci = n;
        } else if (code === 70) {
          flags = parseInt(value, 10) || 0;
        } else if (code === 30) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) defaultZ = n;
        } else if (code === 210) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) nx = n;
        } else if (code === 220) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) ny = n;
        } else if (code === 230) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) nz = n;
        }
        idx += 1;
      }

      const is3DPolyline = (flags & 8) !== 0;
      const isMeshOrPolyface = (flags & 16) !== 0 || (flags & 64) !== 0;
      const pts: DxfContourPoint[] = [];

      while (idx < pairs.length) {
        if (pairs[idx].code === 0 && pairs[idx].value.toUpperCase() === 'SEQEND') {
          idx += 1;
          while (idx < pairs.length && pairs[idx].code !== 0) idx += 1;
          break;
        }
        if (pairs[idx].code === 0 && pairs[idx].value.toUpperCase() === 'VERTEX') {
          idx += 1;
          let vx: number | null = null;
          let vy: number | null = null;
          let vz: number | undefined;
          let vFlags = 0;
          while (idx < pairs.length && pairs[idx].code !== 0) {
            const { code, value } = pairs[idx];
            if (code === 10) vx = parseFloat(value);
            else if (code === 20) vy = parseFloat(value);
            else if (code === 30) vz = parseFloat(value);
            else if (code === 70) vFlags = parseInt(value, 10) || 0;
            idx += 1;
          }
          const isControlOrFace = (vFlags & 64) !== 0 || (vFlags & 16) !== 0 || (vFlags & 128) !== 0;
          if (!isMeshOrPolyface && !isControlOrFace && vx !== null && vy !== null && Number.isFinite(vx) && Number.isFinite(vy)) {
            const rawZ = vz !== undefined && Number.isFinite(vz) ? vz : defaultZ;
            pts.push(is3DPolyline ? { x: vx, y: vy, z: rawZ } : ocsToWcs(vx, vy, rawZ, nx, ny, nz));
          }
          continue;
        }
        if (pairs[idx].code === 0) break;
        idx += 1;
      }

      if (!isMeshOrPolyface && pts.length >= 2) {
        const avgZ = pts.reduce((acc, pt) => acc + pt.z, 0) / pts.length;
        pushEntity({
          layer,
          aci,
          closed: (flags & 1) === 1,
          points: pts,
          avgZ,
        });
      }
      continue;
    }

    if (entityType === 'LINE') {
      let layer = '0';
      let aci: number | undefined;
      let x1: number | null = null;
      let y1: number | null = null;
      let z1 = 0;
      let x2: number | null = null;
      let y2: number | null = null;
      let z2 = 0;

      while (idx < pairs.length && pairs[idx].code !== 0) {
        const { code, value } = pairs[idx];
        if (code === 8) layer = value || '0';
        else if (code === 62) {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) aci = n;
        } else if (code === 10) x1 = parseFloat(value);
        else if (code === 20) y1 = parseFloat(value);
        else if (code === 30) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) z1 = n;
        } else if (code === 11) x2 = parseFloat(value);
        else if (code === 21) y2 = parseFloat(value);
        else if (code === 31) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) z2 = n;
        }
        idx += 1;
      }

      if (
        x1 !== null &&
        y1 !== null &&
        x2 !== null &&
        y2 !== null &&
        Number.isFinite(x1) &&
        Number.isFinite(y1) &&
        Number.isFinite(x2) &&
        Number.isFinite(y2)
      ) {
        pushEntity({
          layer,
          aci,
          closed: false,
          points: [
            { x: x1, y: y1, z: z1 },
            { x: x2, y: y2, z: z2 },
          ],
          avgZ: (z1 + z2) * 0.5,
        });
      }
      continue;
    }

    if (entityType === 'SPLINE') {
      let layer = '0';
      let aci: number | undefined;
      let flags = 0;
      const fitPts: DxfContourPoint[] = [];
      const ctrlPts: DxfContourPoint[] = [];
      let fx: number | null = null;
      let fy: number | null = null;
      let fz = 0;
      let cx: number | null = null;
      let cy: number | null = null;
      let cz = 0;

      const flushFit = () => {
        if (fx !== null && fy !== null && Number.isFinite(fx) && Number.isFinite(fy)) {
          fitPts.push({ x: fx, y: fy, z: fz });
        }
        fx = null;
        fy = null;
        fz = 0;
      };
      const flushCtrl = () => {
        if (cx !== null && cy !== null && Number.isFinite(cx) && Number.isFinite(cy)) {
          ctrlPts.push({ x: cx, y: cy, z: cz });
        }
        cx = null;
        cy = null;
        cz = 0;
      };

      while (idx < pairs.length && pairs[idx].code !== 0) {
        const { code, value } = pairs[idx];
        if (code === 8) layer = value || '0';
        else if (code === 62) {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) aci = n;
        } else if (code === 70) {
          flags = parseInt(value, 10) || 0;
        } else if (code === 11) {
          flushFit();
          fx = parseFloat(value);
        } else if (code === 21) {
          fy = parseFloat(value);
        } else if (code === 31) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) fz = n;
        } else if (code === 10) {
          flushCtrl();
          cx = parseFloat(value);
        } else if (code === 20) {
          cy = parseFloat(value);
        } else if (code === 30) {
          const n = parseFloat(value);
          if (Number.isFinite(n)) cz = n;
        }
        idx += 1;
      }
      flushFit();
      flushCtrl();

      const chosen = fitPts.length >= 2 ? fitPts : ctrlPts;
      if (chosen.length >= 2) {
        const avgZ = chosen.reduce((acc, pt) => acc + pt.z, 0) / chosen.length;
        pushEntity({
          layer,
          aci,
          closed: (flags & 1) === 1,
          points: chosen,
          avgZ,
        });
      }
      continue;
    }

    if (entityType === 'INSERT' && activeSection === 'ENTITIES') {
      let blockName = '';
      let layer = '0';
      let aci: number | undefined;
      let ix = 0;
      let iy = 0;
      let iz = 0;
      let sx = 1;
      let sy = 1;
      let sz = 1;
      let rotDeg = 0;
      let nx = 0;
      let ny = 0;
      let nz = 1;

      while (idx < pairs.length && pairs[idx].code !== 0) {
        const { code, value } = pairs[idx];
        if (code === 2) blockName = value;
        else if (code === 8) layer = value || '0';
        else if (code === 62) {
          const n = parseInt(value, 10);
          if (Number.isFinite(n)) aci = n;
        } else if (code === 10) ix = parseFloat(value) || 0;
        else if (code === 20) iy = parseFloat(value) || 0;
        else if (code === 30) iz = parseFloat(value) || 0;
        else if (code === 41) sx = parseFloat(value) || 1;
        else if (code === 42) sy = parseFloat(value) || 1;
        else if (code === 43) sz = parseFloat(value) || 1;
        else if (code === 50) rotDeg = parseFloat(value) || 0;
        else if (code === 210) nx = parseFloat(value) || 0;
        else if (code === 220) ny = parseFloat(value) || 0;
        else if (code === 230) nz = parseFloat(value) || 1;
        idx += 1;
      }

      if (blockName) {
        const wcsPos = ocsToWcs(ix, iy, iz, nx, ny, nz);
        inserts.push({
          blockName,
          layer,
          aci,
          x: wcsPos.x,
          y: wcsPos.y,
          z: wcsPos.z,
          sx,
          sy,
          sz,
          rotDeg,
        });
      }
      continue;
    }

    // Skip other entity attributes until next code 0
    while (idx < pairs.length && pairs[idx].code !== 0) {
      idx += 1;
    }
  }

  return { entities, blocks, inserts };
}

export function parseDxfContoursText(dxfText: string, fileName: string): ParsedDxfContours {
  const pairs = tokenizeDxfPairs(dxfText);
  const layerColors = parseLayerAciColors(pairs);

  const { entities, blocks, inserts } = extractContoursAndBlocks(pairs);
  const rawEntities: RawContourEntity[] = [...entities];

  for (const ins of inserts) {
    const blk = blocks.get(ins.blockName);
    if (!blk || blk.entities.length === 0) continue;
    const rad = (ins.rotDeg * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);
    for (const ent of blk.entities) {
      const xformPts = ent.points.map((pt) => {
        const lx = (pt.x - blk.base.x) * ins.sx;
        const ly = (pt.y - blk.base.y) * ins.sy;
        const lz = (pt.z - blk.base.z) * ins.sz;
        return {
          x: ins.x + lx * cosR - ly * sinR,
          y: ins.y + lx * sinR + ly * cosR,
          z: ins.z + lz,
        };
      });
      const avgZ = xformPts.reduce((acc, p) => acc + p.z, 0) / xformPts.length;
      rawEntities.push({
        layer: ent.layer === '0' ? ins.layer : ent.layer,
        aci: ent.aci ?? ins.aci,
        closed: ent.closed,
        points: xformPts,
        avgZ,
      });
    }
  }

  // Fallback only if ENTITIES and INSERTs yielded nothing: inspect non-system BLOCK definitions
  if (rawEntities.length === 0) {
    for (const [blkName, blk] of blocks.entries()) {
      if (blkName.startsWith('*')) continue;
      rawEntities.push(...blk.entities);
    }
  }

  if (rawEntities.length === 0) {
    throw new Error(
      `El archivo ${fileName} no contiene entidades vectoriales de curvado compatibles (LWPOLYLINE, POLYLINE, LINE o SPLINE).`
    );
  }

  // Determine elevation interval to distinguish master vs intermediate contours
  const distinctZ = new Set<number>();
  let hasNonFiveMultiple = false;
  for (const ent of rawEntities) {
    const rz = Math.round(ent.avgZ * 100) / 100;
    distinctZ.add(rz);
    if (Math.abs(rz) > 1e-4 && Math.abs(rz / 5 - Math.round(rz / 5)) >= 1e-3) {
      hasNonFiveMultiple = true;
    }
  }

  const layerSet = new Set<string>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let vertexCount = 0;
  let segmentCount = 0;

  const polylines: DxfContourPolyline[] = [];

  for (const ent of rawEntities) {
    if (ent.points.length < 2) continue;

    const layerLower = ent.layer.toLowerCase();
    const layerSaysMaster = /maestr|master|major|index|princ|directr/i.test(layerLower);
    const layerSaysMinor = /interm|minor|secund|ordina/i.test(layerLower);

    let isMaster = false;
    if (layerSaysMaster) {
      isMaster = true;
    } else if (!layerSaysMinor && distinctZ.size > 1 && Math.abs(ent.avgZ) > 1e-4) {
      if (hasNonFiveMultiple) {
        isMaster = Math.abs(ent.avgZ / 5 - Math.round(ent.avgZ / 5)) < 1e-3;
      } else {
        isMaster = Math.abs(ent.avgZ / 25 - Math.round(ent.avgZ / 25)) < 1e-3;
      }
    }

    const effectiveAci = ent.aci && ent.aci !== 256 ? ent.aci : layerColors.get(layerLower);
    const color = aciToContourHex(effectiveAci, isMaster);

    layerSet.add(ent.layer);
    for (const pt of ent.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
      if (pt.z < minZ) minZ = pt.z;
      if (pt.z > maxZ) maxZ = pt.z;
    }

    vertexCount += ent.points.length;
    segmentCount += ent.points.length - 1 + (ent.closed && ent.points.length >= 3 ? 1 : 0);

    polylines.push({
      points: ent.points,
      closed: ent.closed,
      layer: ent.layer,
      elevation: ent.avgZ,
      isMaster,
      color,
    });
  }

  if (polylines.length === 0 || !Number.isFinite(minX) || !Number.isFinite(maxX)) {
    throw new Error(`No se encontraron polilíneas o líneas válidas en ${fileName}.`);
  }

  const planBounds: PlanCoordinateBounds | null =
    maxX > minX && maxY > minY
      ? {
          minE: minX,
          maxE: maxX,
          minN: minY,
          maxN: maxY,
          source: 'dxf',
        }
      : null;

  return {
    fileName,
    polylines,
    segmentCount,
    vertexCount,
    layers: Array.from(layerSet),
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    planBounds,
  };
}

export interface DxfContourProgressInfo {
  percent: number | null;
  loadedBytes: number;
  totalBytes: number | null;
  stage: 'downloading' | 'parsing' | 'geometry' | 'finalizing';
  stageLabel: string;
}

export async function loadDxfContoursFromUrl(
  url: string,
  fileName: string,
  onProgress?: (info: DxfContourProgressInfo) => void
): Promise<ParsedDxfContours> {
  onProgress?.({
    percent: 4,
    loadedBytes: 0,
    totalBytes: null,
    stage: 'downloading',
    stageLabel: 'Conectando para descargar curvado DXF...',
  });

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`No se pudo descargar el DXF de curvado (HTTP ${resp.status}).`);
  }

  const rawLen = Number(resp.headers.get('content-length')) || 0;
  const headerTotal = rawLen > 0 ? rawLen : null;
  let merged: Uint8Array;

  if (resp.body) {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    let lastEmit = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(value);
          loadedBytes += value.byteLength;
          const now = Date.now();
          if (now - lastEmit >= 60) {
            lastEmit = now;
            const pct =
              headerTotal && headerTotal > 0
                ? Math.min(72, Math.max(6, Math.round((loadedBytes / headerTotal) * 72)))
                : null;
            onProgress?.({
              percent: pct,
              loadedBytes,
              totalBytes: headerTotal,
              stage: 'downloading',
              stageLabel: 'Descargando curvado DXF...',
            });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    merged = new Uint8Array(loadedBytes);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
  } else {
    const buf = await resp.arrayBuffer();
    merged = new Uint8Array(buf);
  }

  const finalTotal = headerTotal ?? (merged.byteLength > 0 ? merged.byteLength : null);
  onProgress?.({
    percent: 78,
    loadedBytes: merged.byteLength,
    totalBytes: finalTotal,
    stage: 'parsing',
    stageLabel: 'Procesando polilíneas y curvas de nivel DXF...',
  });
  if (typeof requestAnimationFrame === 'function') {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  let text = new TextDecoder('utf-8').decode(merged);
  if (text.includes('\uFFFD')) {
    text = new TextDecoder('latin1').decode(merged);
  }
  const parsed = parseDxfContoursText(text, fileName);

  onProgress?.({
    percent: 100,
    loadedBytes: merged.byteLength,
    totalBytes: finalTotal,
    stage: 'finalizing',
    stageLabel: 'Curvado DXF listo',
  });

  return parsed;
}

export interface BuildDxfContours3DOptions {
  externalCadTransform?: CadTransform | null;
  externalAssetBox?: THREE.Box3 | null;
}

export interface BuiltDxfContours3DResult {
  group: THREE.Group;
  cadTransform: CadTransform;
  isGeoreferencedMatch: boolean;
}

export function buildDxfContours3DGroup(
  parsed: ParsedDxfContours,
  options: BuildDxfContours3DOptions = {}
): BuiltDxfContours3DResult {
  const group = new THREE.Group();
  const { minX, maxX, minY, maxY, minZ, maxZ } = parsed.bounds;
  const spanX = Math.max(1e-3, maxX - minX);
  const spanY = Math.max(1e-3, maxY - minY);
  const spanZ = Math.max(0, maxZ - minZ);
  const extCad = options.externalCadTransform ?? null;
  const extBox = options.externalAssetBox ?? null;

  let isGeoreferencedMatch = false;
  let mapPoint: (pt: DxfContourPoint) => [number, number, number];
  let resultingCadTransform: CadTransform;

  if (extCad) {
    const extMinE = extCad.cadMin.x;
    const extMaxE = extCad.cadMax.x;
    const extMinN = extCad.zUp ? extCad.cadMin.y : extCad.cadMin.z;
    const extMaxN = extCad.zUp ? extCad.cadMax.y : extCad.cadMax.z;
    const extSpanE = Math.max(1, extMaxE - extMinE);
    const extSpanN = Math.max(1, extMaxN - extMinN);
    const margin = Math.max(60, Math.max(extSpanE, extSpanN, spanX, spanY) * 0.55);

    const overlapsXY =
      maxX >= extMinE - margin &&
      minX <= extMaxE + margin &&
      maxY >= extMinN - margin &&
      minY <= extMaxN + margin;

    if (overlapsXY) {
      isGeoreferencedMatch = true;
      const s = Math.max(1e-9, extCad.scaleFactor);
      const extBoxMinY = extBox ? extBox.min.y : 0;
      const extBoxMaxY = extBox ? extBox.max.y : 20;
      const extMidY = (extBoxMinY + extBoxMaxY) * 0.5 + 0.25;
      const extCadMinZ = extCad.zUp ? extCad.cadMin.z : extCad.cadMin.y;
      const dxfIsFlatZero = spanZ < 1e-3 && Math.abs(minZ) < 1e-3 && extCadMinZ > 5;

      mapPoint = (pt: DxfContourPoint) => {
        if (extCad.zUp) {
          const lx = pt.x - extCad.sourceOrigin.x;
          const ly = pt.y - extCad.sourceOrigin.y;
          const lz = pt.z - extCad.sourceOrigin.z;
          const wx = (lx - extCad.center.x) * s;
          const wz = (-ly - extCad.center.z) * s;
          const wy = dxfIsFlatZero ? extMidY : (lz - extCad.boxMinY) * s + 0.22;
          return [wx, wy, wz];
        }
        const lx = pt.x - extCad.sourceOrigin.x;
        const lz = pt.y - extCad.sourceOrigin.z;
        const ly = pt.z - extCad.sourceOrigin.y;
        const wx = (lx - extCad.center.x) * s;
        const wz = (lz - extCad.center.z) * s;
        const wy = dxfIsFlatZero ? extMidY : (ly - extCad.boxMinY) * s + 0.22;
        return [wx, wy, wz];
      };
      resultingCadTransform = extCad;
    } else if (extBox && !extBox.isEmpty()) {
      // External 3D asset is un-georeferenced (e.g. local GLB); fit DXF centered onto model footprint
      const extCenter = new THREE.Vector3();
      const extSize = new THREE.Vector3();
      extBox.getCenter(extCenter);
      extBox.getSize(extSize);
      const fitScale = Math.min(
        Math.max(1, extSize.x) / spanX,
        Math.max(1, extSize.z) / spanY
      ) * 0.96;
      const dxfMidX = (minX + maxX) * 0.5;
      const dxfMidY = (minY + maxY) * 0.5;
      const zScale = spanZ > 1e-3 ? Math.max(0.01, extSize.y) / spanZ : fitScale;

      mapPoint = (pt: DxfContourPoint) => {
        const wx = extCenter.x + (pt.x - dxfMidX) * fitScale;
        const wz = extCenter.z - (pt.y - dxfMidY) * fitScale;
        const wy =
          spanZ > 1e-3
            ? extBox.min.y + (pt.z - minZ) * zScale + 0.22
            : (extBox.min.y + extBox.max.y) * 0.5 + 0.25;
        return [wx, wy, wz];
      };
      resultingCadTransform = extCad;
    } else {
      isGeoreferencedMatch = false;
      const scale = (TERRAIN_SPAN_M * 0.92) / Math.max(spanX, spanY);
      const cx = (minX + maxX) * 0.5;
      const cy = (minY + maxY) * 0.5;
      mapPoint = (pt: DxfContourPoint) => [
        (pt.x - cx) * scale,
        (pt.z - minZ) * scale + 0.15,
        -(pt.y - cy) * scale,
      ];
      resultingCadTransform = extCad;
    }
  } else {
    // Standalone contour DXF view (no 3D mesh/pointcloud loaded): center on origin with true CAD transform
    const maxHorizSpan = Math.max(spanX, spanY);
    const scale = (TERRAIN_SPAN_M * 0.92) / maxHorizSpan;
    const sourceOrigin = { x: minX, y: minY, z: minZ };
    const localCenterX = spanX * 0.5;
    const localCenterZ = -spanY * 0.5;

    mapPoint = (pt: DxfContourPoint) => {
      const lx = pt.x - sourceOrigin.x;
      const ly = pt.y - sourceOrigin.y;
      const lz = pt.z - sourceOrigin.z;
      return [
        (lx - localCenterX) * scale,
        lz * scale + 0.15,
        (-ly - localCenterZ) * scale,
      ];
    };

    resultingCadTransform = {
      sourceOrigin,
      center: { x: localCenterX, y: 0, z: localCenterZ },
      boxMinY: 0,
      scaleFactor: scale,
      zUp: true,
      cadMin: { x: minX, y: minY, z: minZ },
      cadMax: { x: maxX, y: maxY, z: maxZ },
    };
  }

  // Batch segments by (isMaster + color) so huge contour DXFs render in just a few GPU draw calls
  const buckets = new Map<string, { color: string; isMaster: boolean; coords: number[] }>();

  for (const poly of parsed.polylines) {
    const key = `${poly.isMaster ? 'M' : 'm'}:${poly.color}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { color: poly.color, isMaster: poly.isMaster, coords: [] };
      buckets.set(key, bucket);
    }
    const pts = poly.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = mapPoint(pts[i]);
      const b = mapPoint(pts[i + 1]);
      bucket.coords.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    if (poly.closed && pts.length >= 3) {
      const a = mapPoint(pts[pts.length - 1]);
      const b = mapPoint(pts[0]);
      bucket.coords.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }

  for (const bucket of buckets.values()) {
    if (bucket.coords.length === 0) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(bucket.coords, 3));
    geom.computeBoundingSphere();
    const mat = new THREE.LineBasicMaterial({
      color: bucket.color,
      transparent: true,
      opacity: bucket.isMaster ? 0.96 : 0.78,
      depthTest: true,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.renderOrder = bucket.isMaster ? 4 : 3;
    group.add(lines);
  }

  return {
    group,
    cadTransform: resultingCadTransform,
    isGeoreferencedMatch,
  };
}
