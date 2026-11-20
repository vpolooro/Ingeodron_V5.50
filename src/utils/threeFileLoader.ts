import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { TERRAIN_SPAN_M } from './quarryTerrainModel.ts';

export const SUPPORTED_3D_EXTENSIONS = [
  '.glb',
  '.gltf',
  '.obj',
  '.ply',
  '.stl',
  '.las',
  '.xyz',
  '.pcd',
  '.csv',
  '.txt',
  '.pts',
];

export const SUPPORTED_ORTHO_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff'];

export function getFileExtension(fileName: string): string {
  const clean = fileName.split('?')[0].toLowerCase().trim();
  const idx = clean.lastIndexOf('.');
  return idx >= 0 ? clean.slice(idx) : '';
}

export function isSupported3DFileName(fileName: string): boolean {
  return SUPPORTED_3D_EXTENSIONS.includes(getFileExtension(fileName));
}

export function isSupportedOrthoFileName(fileName: string): boolean {
  return SUPPORTED_ORTHO_EXTENSIONS.includes(getFileExtension(fileName));
}

export interface CadTransform {
  sourceOrigin: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
  boxMinY: number;
  scaleFactor: number;
  zUp: boolean;
  cadMin: { x: number; y: number; z: number };
  cadMax: { x: number; y: number; z: number };
}

export interface GeoAffineTransform {
  a: number;
  b: number;
  d: number;
  e: number;
  f: number;
  h: number;
  widthPx: number;
  heightPx: number;
}

export interface PlanCoordinateBounds {
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
  source: 'geotiff' | 'model3d' | 'dxf' | 'local';
  geoAffine?: GeoAffineTransform;
}

export interface LoadedOrthophotoResult {
  canvas: HTMLCanvasElement;
  naturalWidth: number;
  naturalHeight: number;
  geoBounds: PlanCoordinateBounds | null;
}

export function scenePointToCadCoords(
  worldX: number,
  baseY: number,
  worldZ: number,
  cadTransform: CadTransform
): { easting: number; northing: number; elevation: number } {
  const s = Math.max(1e-9, cadTransform.scaleFactor);
  if (cadTransform.zUp) {
    return {
      easting: worldX / s + cadTransform.center.x + cadTransform.sourceOrigin.x,
      northing: -(worldZ / s + cadTransform.center.z) + cadTransform.sourceOrigin.y,
      elevation: baseY / s + cadTransform.boxMinY + cadTransform.sourceOrigin.z,
    };
  }
  return {
    easting: worldX / s + cadTransform.center.x + cadTransform.sourceOrigin.x,
    northing: worldZ / s + cadTransform.center.z + cadTransform.sourceOrigin.z,
    elevation: baseY / s + cadTransform.boxMinY + cadTransform.sourceOrigin.y,
  };
}

export function cadTransformToPlanBounds(cadTransform: CadTransform): PlanCoordinateBounds | null {
  const minE = cadTransform.cadMin.x;
  const maxE = cadTransform.cadMax.x;
  const minN = cadTransform.zUp ? cadTransform.cadMin.y : cadTransform.cadMin.z;
  const maxN = cadTransform.zUp ? cadTransform.cadMax.y : cadTransform.cadMax.z;
  if (
    !Number.isFinite(minE) ||
    !Number.isFinite(maxE) ||
    !Number.isFinite(minN) ||
    !Number.isFinite(maxN) ||
    maxE <= minE ||
    maxN <= minN
  ) {
    return null;
  }
  return { minE, maxE, minN, maxN, source: 'model3d' };
}

export function cadToSceneXZ(
  easting: number,
  northing: number,
  cadTransform: CadTransform
): { worldX: number; worldZ: number } {
  const s = Math.max(1e-9, cadTransform.scaleFactor);
  if (cadTransform.zUp) {
    const lx = easting - cadTransform.sourceOrigin.x;
    const ly = northing - cadTransform.sourceOrigin.y;
    return {
      worldX: (lx - cadTransform.center.x) * s,
      worldZ: (-ly - cadTransform.center.z) * s,
    };
  }
  const lx = easting - cadTransform.sourceOrigin.x;
  const lz = northing - cadTransform.sourceOrigin.z;
  return {
    worldX: (lx - cadTransform.center.x) * s,
    worldZ: (lz - cadTransform.center.z) * s,
  };
}

export function planBoundsOverlapCad(
  cadTransform: CadTransform,
  bounds: PlanCoordinateBounds
): boolean {
  const cadMinE = cadTransform.cadMin.x;
  const cadMaxE = cadTransform.cadMax.x;
  const cadMinN = cadTransform.zUp ? cadTransform.cadMin.y : cadTransform.cadMin.z;
  const cadMaxN = cadTransform.zUp ? cadTransform.cadMax.y : cadTransform.cadMax.z;
  if (
    !Number.isFinite(cadMinE) ||
    !Number.isFinite(cadMaxE) ||
    !Number.isFinite(cadMinN) ||
    !Number.isFinite(cadMaxN)
  ) {
    return false;
  }
  const cadSpanE = Math.max(1, cadMaxE - cadMinE);
  const cadSpanN = Math.max(1, cadMaxN - cadMinN);
  const bSpanE = Math.max(1, bounds.maxE - bounds.minE);
  const bSpanN = Math.max(1, bounds.maxN - bounds.minN);
  const margin = Math.max(80, Math.max(cadSpanE, cadSpanN, bSpanE, bSpanN) * 0.65);
  return (
    bounds.maxE >= cadMinE - margin &&
    bounds.minE <= cadMaxE + margin &&
    bounds.maxN >= cadMinN - margin &&
    bounds.minN <= cadMaxN + margin
  );
}

export function computePlanarOrthoUv(
  wx: number,
  wz: number,
  cadTransform: CadTransform | null,
  orthoBounds: PlanCoordinateBounds | null,
  fallbackBox: { minX: number; maxX: number; minZ: number; maxZ: number }
): [number, number] {
  if (cadTransform && orthoBounds && planBoundsOverlapCad(cadTransform, orthoBounds)) {
    const cad = scenePointToCadCoords(wx, 0, wz, cadTransform);
    const aff = orthoBounds.geoAffine;
    if (aff && aff.widthPx > 0 && aff.heightPx > 0) {
      const det = aff.a * aff.f - aff.b * aff.e;
      if (Number.isFinite(det) && Math.abs(det) > 1e-18) {
        const de = cad.easting - aff.d;
        const dn = cad.northing - aff.h;
        const px = (aff.f * de - aff.b * dn) / det;
        const py = (-aff.e * de + aff.a * dn) / det;
        return [px / aff.widthPx, 1 - py / aff.heightPx];
      }
    }
    const spanE = Math.max(1e-6, orthoBounds.maxE - orthoBounds.minE);
    const spanN = Math.max(1e-6, orthoBounds.maxN - orthoBounds.minN);
    return [
      (cad.easting - orthoBounds.minE) / spanE,
      (cad.northing - orthoBounds.minN) / spanN,
    ];
  }
  const spanX = Math.max(1e-6, fallbackBox.maxX - fallbackBox.minX);
  const spanZ = Math.max(1e-6, fallbackBox.maxZ - fallbackBox.minZ);
  return [(wx - fallbackBox.minX) / spanX, (fallbackBox.maxZ - wz) / spanZ];
}

export interface CompanionAssetRef {
  fileName: string;
  url: string;
}

export interface Load3DProgressInfo {
  percent: number | null;
  loadedBytes: number;
  totalBytes: number | null;
  stage: 'downloading' | 'parsing' | 'geometry' | 'finalizing';
  stageLabel: string;
}

export interface Load3DAssetOptions {
  maxPoints?: number;
  pointSize?: number;
  maxAnisotropy?: number;
  companionAssets?: CompanionAssetRef[];
  onProgress?: (info: Load3DProgressInfo) => void;
}

export interface Loaded3DAssetResult {
  group: THREE.Group;
  kind: 'mesh' | 'pointcloud';
  pointOrVertexCount: number;
  totalSourcePoints?: number;
  rawBoundsMin: THREE.Vector3;
  rawBoundsMax: THREE.Vector3;
  normalizedHeightSpan: number;
  hasTextures: boolean;
  cadTransform: CadTransform;
  setHypsometricMode: (enabled: boolean) => void;
  setWireframeMode: (enabled: boolean) => void;
  setOrthophotoOverlay: (
    texture: THREE.Texture | null,
    orthoBounds?: PlanCoordinateBounds | null,
    orthoCanvas?: HTMLCanvasElement | null
  ) => void;
  setZUpOrientation: (zUp: boolean) => void;
  setPointSize: (size: number) => void;
  dispose: () => void;
}

export function createPointCircleSpriteTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.44, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function hypsometricNormalizedRgb(tRaw: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, tRaw));
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [29, 78, 216]],
    [0.22, [6, 182, 212]],
    [0.44, [16, 185, 129]],
    [0.64, [234, 179, 8]],
    [0.82, [249, 115, 22]],
    [0.95, [220, 38, 38]],
    [1.0, [248, 250, 252]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1);
      return [
        (c0[0] + (c1[0] - c0[0]) * f) / 255,
        (c0[1] + (c1[1] - c0[1]) * f) / 255,
        (c0[2] + (c1[2] - c0[2]) * f) / 255,
      ];
    }
  }
  return [0.97, 0.98, 0.99];
}

const SRGB_U8_TO_LINEAR_U8 = (() => {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    const lin = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    lut[i] = Math.max(0, Math.min(255, Math.round(lin * 255)));
  }
  return lut;
})();

const POINT_CLOUD_CHUNK_SIZE = 4_000_000;
const MAX_SUPPORTED_POINTS = 50_000_000;

function appendPointCloudChunk(
  contentHolder: THREE.Group,
  positions: Float32Array,
  colors: Uint8Array | null,
  count: number,
  material: THREE.PointsMaterial
): void {
  if (count <= 0) return;
  const posSlice =
    count * 3 === positions.length ? positions : positions.slice(0, count * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(posSlice, 3));
  if (colors) {
    const colSlice =
      count * 3 === colors.length ? colors : colors.slice(0, count * 3);
    geom.setAttribute('color', new THREE.Uint8BufferAttribute(colSlice, 3, true));
  }
  contentHolder.add(new THREE.Points(geom, material));
}

function yieldToUiFrame(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function readResponseAsChunks(
  resp: Response,
  onChunk: (chunk: Uint8Array) => boolean | void,
  onBytesProgress?: (loadedBytes: number, totalBytes: number | null) => void
): Promise<void> {
  const rawLen = Number(resp.headers.get('content-length')) || 0;
  const totalBytes = rawLen > 0 ? rawLen : null;
  let loadedBytes = 0;
  let lastEmitMs = 0;

  onBytesProgress?.(0, totalBytes);

  if (resp.body) {
    const reader = resp.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          loadedBytes += value.byteLength;
          const now = Date.now();
          if (now - lastEmitMs >= 60) {
            lastEmitMs = now;
            onBytesProgress?.(loadedBytes, totalBytes);
          }
          const shouldStop = onChunk(value);
          if (shouldStop === true) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    onBytesProgress?.(loadedBytes, totalBytes ?? (loadedBytes > 0 ? loadedBytes : null));
    return;
  }
  const buf = await resp.arrayBuffer();
  const u8 = new Uint8Array(buf);
  loadedBytes = u8.byteLength;
  onBytesProgress?.(loadedBytes, totalBytes ?? (loadedBytes > 0 ? loadedBytes : null));
  onChunk(u8);
}

async function readResponseBufferWithProgress(
  resp: Response,
  onBytesProgress?: (loadedBytes: number, totalBytes: number | null) => void
): Promise<{ buffer: ArrayBuffer; loadedBytes: number; totalBytes: number | null }> {
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  const rawLen = Number(resp.headers.get('content-length')) || 0;
  const headerTotal = rawLen > 0 ? rawLen : null;

  await readResponseAsChunks(
    resp,
    (chunk) => {
      chunks.push(chunk);
      totalLen += chunk.byteLength;
    },
    onBytesProgress
  );

  if (chunks.length === 1 && chunks[0].byteOffset === 0 && chunks[0].byteLength === chunks[0].buffer.byteLength) {
    return {
      buffer: chunks[0].buffer as ArrayBuffer,
      loadedBytes: totalLen,
      totalBytes: headerTotal ?? (totalLen > 0 ? totalLen : null),
    };
  }

  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return {
    buffer: merged.buffer,
    loadedBytes: totalLen,
    totalBytes: headerTotal ?? (totalLen > 0 ? totalLen : null),
  };
}

async function parseAsciiPointCloudStream(
  resp: Response,
  contentHolder: THREE.Group,
  material: THREE.PointsMaterial,
  maxPoints = MAX_SUPPORTED_POINTS,
  onBytesProgress?: (loadedBytes: number, totalBytes: number | null) => void
): Promise<{ totalPointsLoaded: number; totalFilePoints: number; origin: THREE.Vector3; loadedBytes: number; totalBytes: number | null }> {
  const effectiveMax = Math.min(
    MAX_SUPPORTED_POINTS,
    maxPoints <= 0 ? MAX_SUPPORTED_POINTS : maxPoints
  );
  const contentLength = Number(resp.headers.get('content-length')) || 0;
  const decoder = new TextDecoder('utf-8');
  let finalLoadedBytes = 0;
  let finalTotalBytes: number | null = contentLength > 0 ? contentLength : null;

  let tail = '';
  let stride = 1;
  let strideResolved = false;
  let lineIdx = 0;
  let totalValidLines = 0;
  let totalSampled = 0;

  let originSet = false;
  let originX = 0;
  let originY = 0;
  let originZ = 0;
  let hasColor = false;

  let chunkCap = Math.min(POINT_CLOUD_CHUNK_SIZE, effectiveMax);
  let chunkPositions = new Float32Array(chunkCap * 3);
  let chunkColors = new Uint8Array(chunkCap * 3);
  let chunkCount = 0;

  const flushChunk = () => {
    if (chunkCount === 0) return;
    appendPointCloudChunk(
      contentHolder,
      chunkPositions,
      hasColor ? chunkColors : null,
      chunkCount,
      material
    );
    const remaining = Math.max(0, effectiveMax - totalSampled);
    chunkCap = Math.min(POINT_CLOUD_CHUNK_SIZE, Math.max(1, remaining));
    if (remaining > 0) {
      chunkPositions = new Float32Array(chunkCap * 3);
      chunkColors = new Uint8Array(chunkCap * 3);
    }
    chunkCount = 0;
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//') || /^[a-zA-Z]/.test(line)) {
      return;
    }
    const idx = lineIdx++;
    if (idx % stride !== 0 || totalSampled >= effectiveMax) {
      return;
    }

    const parts = line.split(/[\s,;]+/);
    if (parts.length < 3) return;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    if (!originSet) {
      originX = x;
      originY = y;
      originZ = z;
      originSet = true;
    }

    if (chunkCount >= chunkCap) {
      flushChunk();
    }

    chunkPositions[chunkCount * 3] = x - originX;
    chunkPositions[chunkCount * 3 + 1] = y - originY;
    chunkPositions[chunkCount * 3 + 2] = z - originZ;

    if (parts.length >= 6) {
      const r = Number(parts[3]);
      const g = Number(parts[4]);
      const b = Number(parts[5]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        hasColor = true;
        const maxC = Math.max(r, g, b);
        const scale = maxC > 1.01 ? 1 : 255;
        const rU8 = Math.max(0, Math.min(255, Math.round(r * scale)));
        const gU8 = Math.max(0, Math.min(255, Math.round(g * scale)));
        const bU8 = Math.max(0, Math.min(255, Math.round(b * scale)));
        chunkColors[chunkCount * 3] = SRGB_U8_TO_LINEAR_U8[rU8];
        chunkColors[chunkCount * 3 + 1] = SRGB_U8_TO_LINEAR_U8[gU8];
        chunkColors[chunkCount * 3 + 2] = SRGB_U8_TO_LINEAR_U8[bU8];
      }
    }

    chunkCount++;
    totalSampled++;
    totalValidLines += stride;
  };

  await readResponseAsChunks(resp, (bytes) => {
    const textChunk = tail + decoder.decode(bytes, { stream: true });
    if (!strideResolved && contentLength > 0 && textChunk.length > 512) {
      const firstNl = textChunk.indexOf('\n');
      const secondNl = firstNl >= 0 ? textChunk.indexOf('\n', firstNl + 1) : -1;
      if (secondNl > firstNl) {
        const sampleBytes = Math.max(12, secondNl - firstNl);
        const estimatedLines = Math.ceil(contentLength / sampleBytes);
        stride = Math.max(1, Math.ceil(estimatedLines / effectiveMax));
      }
      strideResolved = true;
    }

    let start = 0;
    while (true) {
      const nl = textChunk.indexOf('\n', start);
      if (nl < 0) break;
      processLine(textChunk.slice(start, nl));
      start = nl + 1;
      if (totalSampled >= effectiveMax) {
        tail = '';
        return true;
      }
    }
    tail = textChunk.slice(start);
    return false;
  }, (loadedBytes, totalBytes) => {
    finalLoadedBytes = loadedBytes;
    finalTotalBytes = totalBytes;
    onBytesProgress?.(loadedBytes, totalBytes);
  });

  const finalTail = tail + decoder.decode();
  if (finalTail && totalSampled < effectiveMax) {
    processLine(finalTail);
  }
  flushChunk();

  if (totalSampled === 0) {
    throw new Error('El archivo ASCII no contiene puntos X Y Z válidos.');
  }

  return {
    totalPointsLoaded: totalSampled,
    totalFilePoints: stride === 1 ? totalSampled : Math.max(totalSampled, totalValidLines),
    origin: new THREE.Vector3(originX, originY, originZ),
    loadedBytes: finalLoadedBytes,
    totalBytes: finalTotalBytes,
  };
}

async function parseBinaryLasStream(
  resp: Response,
  contentHolder: THREE.Group,
  material: THREE.PointsMaterial,
  maxPoints = MAX_SUPPORTED_POINTS,
  onBytesProgress?: (loadedBytes: number, totalBytes: number | null) => void
): Promise<{ totalPointsLoaded: number; totalFilePoints: number; origin: THREE.Vector3; loadedBytes: number; totalBytes: number | null }> {
  const effectiveMax = Math.min(
    MAX_SUPPORTED_POINTS,
    maxPoints <= 0 ? MAX_SUPPORTED_POINTS : maxPoints
  );
  const contentLength = Number(resp.headers.get('content-length')) || 0;
  let finalLoadedBytes = 0;
  let finalTotalBytes: number | null = contentLength > 0 ? contentLength : null;

  let pending = new Uint8Array(0);
  let headerParsed = false;
  let probeDone = false;

  let offsetToPoints = 0;
  let pointFormat = 0;
  let pointRecordLen = 0;
  let totalRecords = 0;
  let scaleX = 0.001;
  let scaleY = 0.001;
  let scaleZ = 0.001;
  let offX = 0;
  let offY = 0;
  let offZ = 0;
  let rgbOffset = -1;
  let hasRgb = false;
  let is16BitRgb = false;

  let stride = 1;
  let originSet = false;
  let originX = 0;
  let originY = 0;
  let originZ = 0;

  let recordIdx = 0;
  let totalSampled = 0;

  let chunkCap = 0;
  let chunkPositions = new Float32Array(0);
  let chunkColors: Uint8Array | null = null;
  let chunkCount = 0;

  const initChunk = () => {
    const remainingBudget = Math.max(1, effectiveMax - totalSampled);
    const remainingRecordsEst = Math.max(
      1,
      Math.ceil(Math.max(0, totalRecords - recordIdx) / stride)
    );
    chunkCap = Math.min(POINT_CLOUD_CHUNK_SIZE, remainingBudget, remainingRecordsEst);
    chunkPositions = new Float32Array(chunkCap * 3);
    chunkColors = hasRgb ? new Uint8Array(chunkCap * 3) : null;
    chunkCount = 0;
  };

  const flushChunk = (allocateNext: boolean) => {
    if (chunkCount > 0) {
      appendPointCloudChunk(contentHolder, chunkPositions, chunkColors, chunkCount, material);
    }
    chunkCount = 0;
    if (allocateNext && totalSampled < effectiveMax && recordIdx < totalRecords) {
      initChunk();
    }
  };

  const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    if (a.byteLength === 0) return b;
    const merged = new Uint8Array(a.byteLength + b.byteLength);
    merged.set(a, 0);
    merged.set(b, a.byteLength);
    return merged;
  };

  const processBuffer = (buf: Uint8Array, isFinalFlush: boolean): { consumed: number; stop: boolean } => {
    if (!headerParsed) {
      if (buf.byteLength < 227) {
        if (isFinalFlush) {
          throw new Error('Archivo LAS demasiado pequeño o corrupto.');
        }
        return { consumed: 0, stop: false };
      }
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const sig =
        String.fromCharCode(view.getUint8(0)) +
        String.fromCharCode(view.getUint8(1)) +
        String.fromCharCode(view.getUint8(2)) +
        String.fromCharCode(view.getUint8(3));
      if (sig !== 'LASF') {
        throw new Error('Cabecera LASF no válida.');
      }

      const legacyCount = view.getUint32(107, true);
      if (legacyCount === 0 && buf.byteLength < 255 && !isFinalFlush) {
        return { consumed: 0, stop: false };
      }

      offsetToPoints = view.getUint32(96, true);
      pointFormat = view.getUint8(104) & 0x3f;
      pointRecordLen = view.getUint16(105, true);
      let pointCount = legacyCount;
      if (pointCount === 0 && buf.byteLength >= 255) {
        const low = view.getUint32(247, true);
        const high = view.getUint32(251, true);
        pointCount = low + high * 4294967296;
      }

      scaleX = view.getFloat64(131, true) || 0.001;
      scaleY = view.getFloat64(139, true) || 0.001;
      scaleZ = view.getFloat64(147, true) || 0.001;
      offX = view.getFloat64(155, true) || 0;
      offY = view.getFloat64(163, true) || 0;
      offZ = view.getFloat64(171, true) || 0;

      if (pointRecordLen < 12 || (contentLength > 0 && offsetToPoints >= contentLength)) {
        throw new Error('Formato de registros LAS no válido.');
      }

      const availableFromLength =
        contentLength > offsetToPoints
          ? Math.floor((contentLength - offsetToPoints) / pointRecordLen)
          : 0;
      totalRecords =
        pointCount > 0 && availableFromLength > 0
          ? Math.min(pointCount, availableFromLength)
          : pointCount || availableFromLength;

      if (totalRecords <= 0) {
        throw new Error('El archivo LAS no contiene registros de puntos.');
      }

      if (pointFormat === 2) rgbOffset = 20;
      else if (pointFormat === 3 || pointFormat === 5) rgbOffset = 28;
      else if ((pointFormat === 7 || pointFormat === 8 || pointFormat === 10) && pointRecordLen >= 36) {
        rgbOffset = 30;
      }

      stride = Math.max(1, Math.ceil(totalRecords / effectiveMax));
      headerParsed = true;
    }

    if (!probeDone) {
      const probeRecords = Math.min(totalRecords, 512);
      const minProbeBytes = offsetToPoints + Math.min(probeRecords, 64) * pointRecordLen;
      if (buf.byteLength < minProbeBytes && !isFinalFlush) {
        return { consumed: 0, stop: false };
      }
      if (buf.byteLength < offsetToPoints + pointRecordLen) {
        if (isFinalFlush) {
          throw new Error('El archivo LAS no contiene registros de puntos.');
        }
        return { consumed: 0, stop: false };
      }

      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      if (rgbOffset >= 0) {
        const availableProbe = Math.floor((buf.byteLength - offsetToPoints) / pointRecordLen);
        const countToProbe = Math.min(availableProbe, probeRecords);
        for (let i = 0; i < countToProbe; i++) {
          const base = offsetToPoints + i * pointRecordLen;
          if (base + rgbOffset + 6 > buf.byteLength) break;
          const r16 = view.getUint16(base + rgbOffset, true);
          const g16 = view.getUint16(base + rgbOffset + 2, true);
          const b16 = view.getUint16(base + rgbOffset + 4, true);
          if (r16 > 0 || g16 > 0 || b16 > 0) hasRgb = true;
          if (r16 > 255 || g16 > 255 || b16 > 255) {
            is16BitRgb = true;
            break;
          }
        }
      }

      initChunk();
      probeDone = true;
      // Start consuming point records starting at offsetToPoints
      const res = consumeRecords(buf, offsetToPoints);
      return res;
    }

    return consumeRecords(buf, 0);
  };

  const consumeRecords = (buf: Uint8Array, startByteOffset: number): { consumed: number; stop: boolean } => {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let cursor = startByteOffset;

    while (cursor + pointRecordLen <= buf.byteLength && recordIdx < totalRecords) {
      if (recordIdx % stride === 0 && totalSampled < effectiveMax) {
        const ix = view.getInt32(cursor, true);
        const iy = view.getInt32(cursor + 4, true);
        const iz = view.getInt32(cursor + 8, true);

        const wx = ix * scaleX + offX;
        const wy = iy * scaleY + offY;
        const wz = iz * scaleZ + offZ;

        if (!originSet) {
          originX = wx;
          originY = wy;
          originZ = wz;
          originSet = true;
        }

        if (chunkCount >= chunkCap) {
          flushChunk(true);
        }

        chunkPositions[chunkCount * 3] = wx - originX;
        chunkPositions[chunkCount * 3 + 1] = wy - originY;
        chunkPositions[chunkCount * 3 + 2] = wz - originZ;

        if (chunkColors && rgbOffset >= 0 && cursor + rgbOffset + 6 <= buf.byteLength) {
          const r16 = view.getUint16(cursor + rgbOffset, true);
          const g16 = view.getUint16(cursor + rgbOffset + 2, true);
          const b16 = view.getUint16(cursor + rgbOffset + 4, true);
          const rU8 = is16BitRgb ? r16 >> 8 : r16 & 255;
          const gU8 = is16BitRgb ? g16 >> 8 : g16 & 255;
          const bU8 = is16BitRgb ? b16 >> 8 : b16 & 255;
          chunkColors[chunkCount * 3] = SRGB_U8_TO_LINEAR_U8[rU8];
          chunkColors[chunkCount * 3 + 1] = SRGB_U8_TO_LINEAR_U8[gU8];
          chunkColors[chunkCount * 3 + 2] = SRGB_U8_TO_LINEAR_U8[bU8];
        }

        chunkCount++;
        totalSampled++;
      }

      cursor += pointRecordLen;
      recordIdx++;

      if (totalSampled >= effectiveMax || recordIdx >= totalRecords) {
        return { consumed: cursor, stop: true };
      }
    }

    return { consumed: cursor, stop: false };
  };

  await readResponseAsChunks(resp, (chunk) => {
    const merged = concatBytes(pending, chunk);
    const { consumed, stop } = processBuffer(merged, false);
    if (stop) {
      pending = new Uint8Array(0);
      return true;
    }
    const remLen = merged.byteLength - consumed;
    pending = remLen > 0 ? merged.slice(consumed) : new Uint8Array(0);
    return false;
  }, (loadedBytes, totalBytes) => {
    finalLoadedBytes = loadedBytes;
    finalTotalBytes = totalBytes;
    onBytesProgress?.(loadedBytes, totalBytes);
  });

  if (pending.byteLength > 0 && (!probeDone || (recordIdx < totalRecords && totalSampled < effectiveMax))) {
    processBuffer(pending, true);
  }
  flushChunk(false);

  if (totalSampled === 0) {
    throw new Error('El archivo LAS no contiene registros de puntos.');
  }

  return {
    totalPointsLoaded: totalSampled,
    totalFilePoints: totalRecords,
    origin: new THREE.Vector3(originX, originY, originZ),
    loadedBytes: finalLoadedBytes,
    totalBytes: finalTotalBytes,
  };
}

export async function load3DAssetFromUrl(
  url: string,
  fileName: string,
  isSoftwareGl: boolean,
  options: Load3DAssetOptions = {}
): Promise<Loaded3DAssetResult> {
  const ext = getFileExtension(fileName);
  if (ext === '.laz') {
    throw new Error(
      'El formato comprimido .LAZ requiere descompresión previa. Sube el archivo en formato .LAS, .PLY, .XYZ, .PCD, .OBJ o .GLB para visualizarlo directamente en 3D.'
    );
  }

  const maxPoints = options.maxPoints ?? MAX_SUPPORTED_POINTS;
  const initialPointSize = options.pointSize ?? 1.0;
  const maxAnisotropy = Math.max(1, options.maxAnisotropy ?? 8);
  const onProgress = options.onProgress;

  let lastKnownLoadedBytes = 0;
  let lastKnownTotalBytes: number | null = null;

  const emitProgress = (info: Load3DProgressInfo) => {
    lastKnownLoadedBytes = info.loadedBytes;
    lastKnownTotalBytes = info.totalBytes;
    onProgress?.(info);
  };

  emitProgress({
    percent: 2,
    loadedBytes: 0,
    totalBytes: null,
    stage: 'downloading',
    stageLabel: 'Conectando con el servidor...',
  });

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`No se pudo descargar el archivo 3D (${resp.status}).`);
  }

  const rootGroup = new THREE.Group();
  const contentHolder = new THREE.Group();
  rootGroup.add(contentHolder);

  let kind: 'mesh' | 'pointcloud' = 'mesh';
  let hasTextures = false;
  let defaultZUp = true;
  let totalSourcePoints: number | undefined;
  const sourceOrigin = new THREE.Vector3(0, 0, 0);
  const pointSpriteTex = createPointCircleSpriteTexture();

  const meshes: Array<{
    mesh: THREE.Mesh;
    baseMaterial: THREE.Material | THREE.Material[];
    hypsoMaterial: THREE.MeshStandardMaterial;
    orthoMaterial: THREE.MeshStandardMaterial | null;
    hasEmbeddedMap: boolean;
  }> = [];
  const pointClouds: Array<{
    points: THREE.Points;
    originalColorAttr: THREE.BufferAttribute | null;
    hypsoColorAttr: THREE.BufferAttribute | null;
    orthoColorAttr: THREE.BufferAttribute | null;
    orthoColorKey: string | null;
    buildHypsoAttr: () => THREE.BufferAttribute;
    material: THREE.PointsMaterial;
  }> = [];
  const tempBlobUrls: string[] = [];
  const companionAssets = options.companionAssets ?? [];

  const handleBufferDownloadProgress = (loadedBytes: number, totalBytes: number | null) => {
    const pct =
      totalBytes && totalBytes > 0
        ? Math.min(72, Math.max(3, Math.round((loadedBytes / totalBytes) * 72)))
        : null;
    emitProgress({
      percent: pct,
      loadedBytes,
      totalBytes,
      stage: 'downloading',
      stageLabel: 'Descargando modelo 3D...',
    });
  };

  const handleStreamDownloadProgress = (loadedBytes: number, totalBytes: number | null) => {
    const pct =
      totalBytes && totalBytes > 0
        ? Math.min(88, Math.max(3, Math.round((loadedBytes / totalBytes) * 88)))
        : null;
    emitProgress({
      percent: pct,
      loadedBytes,
      totalBytes,
      stage: 'downloading',
      stageLabel: 'Descargando y procesando nube de puntos...',
    });
  };

  if (ext === '.glb' || ext === '.gltf') {
    defaultZUp = false;
    const { buffer, loadedBytes, totalBytes } = await readResponseBufferWithProgress(
      resp,
      handleBufferDownloadProgress
    );
    emitProgress({
      percent: 76,
      loadedBytes,
      totalBytes,
      stage: 'parsing',
      stageLabel: 'Procesando malla GLTF / GLB...',
    });
    await yieldToUiFrame();
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(buffer, '');
    contentHolder.add(gltf.scene);
  } else if (ext === '.obj') {
    const { buffer, loadedBytes, totalBytes } = await readResponseBufferWithProgress(
      resp,
      handleBufferDownloadProgress
    );
    emitProgress({
      percent: 76,
      loadedBytes,
      totalBytes,
      stage: 'parsing',
      stageLabel: 'Procesando geometría OBJ...',
    });
    await yieldToUiFrame();
    const text = new TextDecoder('utf-8').decode(buffer);
    const loader = new OBJLoader();

    // Resolve companion .mtl & texture deliverables if available
    if (companionAssets.length > 0) {
      const stripExt = (n: string) => {
        const clean = n.split('?')[0].toLowerCase().trim();
        const dot = clean.lastIndexOf('.');
        return dot >= 0 ? clean.slice(0, dot) : clean;
      };
      const baseNameOnly = (raw: string) => {
        const noQuery = raw.split('?')[0].replace(/\\/g, '/').trim();
        const seg = noQuery.split('/').pop() || noQuery;
        return seg.toLowerCase();
      };
      const findCompanionByName = (refName: string): CompanionAssetRef | undefined => {
        const target = baseNameOnly(refName);
        if (!target) return undefined;
        return companionAssets.find((a) => baseNameOnly(a.fileName) === target);
      };

      let mtlRef: CompanionAssetRef | undefined;
      const mtllibMatch = text.match(/^\s*mtllib\s+(.+)$/im);
      if (mtllibMatch?.[1]) {
        mtlRef = findCompanionByName(mtllibMatch[1].trim());
      }
      if (!mtlRef) {
        const expectedMtl = `${stripExt(baseNameOnly(fileName))}.mtl`;
        mtlRef = findCompanionByName(expectedMtl);
      }

      if (mtlRef) {
        try {
          const mtlResp = await fetch(mtlRef.url);
          if (mtlResp.ok) {
            const mtlText = await mtlResp.text();
            // Pre-convert any .tif/.tiff texture references into PNG blob URLs so MTLLoader can load them
            const resolvedUrlMap = new Map<string, string>();
            for (const asset of companionAssets) {
              const bName = baseNameOnly(asset.fileName);
              if (!bName || resolvedUrlMap.has(bName)) continue;
              const assetExt = getFileExtension(asset.fileName);
              if (assetExt === '.tif' || assetExt === '.tiff') {
                // Only decode TIFF if referenced inside the MTL
                const escaped = bName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (new RegExp(escaped, 'i').test(mtlText)) {
                  try {
                    const decoded = await loadOrthophotoDataFromUrl(asset.url, asset.fileName);
                    const blobUrl = await new Promise<string | null>((resBlob) =>
                      decoded.canvas.toBlob((b) => resBlob(b ? URL.createObjectURL(b) : null), 'image/png')
                    );
                    if (blobUrl) {
                      tempBlobUrls.push(blobUrl);
                      resolvedUrlMap.set(bName, blobUrl);
                      continue;
                    }
                  } catch {
                    // Fall through to raw URL
                  }
                }
              }
              resolvedUrlMap.set(bName, asset.url);
            }

            let pendingDone: (() => void) | null = null;
            let loadedAll = false;
            const manager = new THREE.LoadingManager(() => {
              loadedAll = true;
              pendingDone?.();
            });
            manager.setURLModifier((reqUrl) => {
              if (reqUrl.startsWith('blob:') || reqUrl.startsWith('data:')) return reqUrl;
              const bName = baseNameOnly(reqUrl);
              return resolvedUrlMap.get(bName) ?? reqUrl;
            });

            const mtlLoader = new MTLLoader(manager);
            mtlLoader.setMaterialOptions({ side: THREE.DoubleSide });
            const materials = mtlLoader.parse(mtlText, '');
            materials.preload();

            // Wait briefly for referenced textures to decode if any were queued
            if (!loadedAll && Object.keys(materials.materialsInfo).length > 0) {
              await new Promise<void>((resolve) => {
                pendingDone = resolve;
                window.setTimeout(resolve, 4500);
              });
            }

            Object.values(materials.materials).forEach((m) => {
              const matAny = m as THREE.MeshPhongMaterial;
              if (matAny.map) {
                matAny.map.colorSpace = THREE.SRGBColorSpace;
                matAny.map.anisotropy = maxAnisotropy;
                matAny.map.needsUpdate = true;
              }
            });
            loader.setMaterials(materials);
          }
        } catch {
          // Non-fatal: continue loading geometry cleanly even if MTL fetch/parse fails
        }
      }
    }

    const obj = loader.parse(text);
    contentHolder.add(obj);
  } else if (ext === '.stl') {
    const { buffer, loadedBytes, totalBytes } = await readResponseBufferWithProgress(
      resp,
      handleBufferDownloadProgress
    );
    emitProgress({
      percent: 76,
      loadedBytes,
      totalBytes,
      stage: 'parsing',
      stageLabel: 'Procesando malla STL...',
    });
    await yieldToUiFrame();
    const loader = new STLLoader();
    const geom = loader.parse(buffer);
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: '#cbd5e1',
      roughness: 0.78,
      metalness: 0.08,
    });
    contentHolder.add(new THREE.Mesh(geom, mat));
  } else if (ext === '.ply') {
    const { buffer, loadedBytes, totalBytes } = await readResponseBufferWithProgress(
      resp,
      handleBufferDownloadProgress
    );
    emitProgress({
      percent: 76,
      loadedBytes,
      totalBytes,
      stage: 'parsing',
      stageLabel: 'Procesando geometría PLY...',
    });
    await yieldToUiFrame();
    const loader = new PLYLoader();
    const geom = loader.parse(buffer);
    if (geom.index || (geom.attributes.normal && geom.attributes.position.count > 0 && !geom.attributes.color)) {
      geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        color: '#cbd5e1',
        vertexColors: Boolean(geom.attributes.color),
        roughness: 0.8,
        metalness: 0.05,
      });
      contentHolder.add(new THREE.Mesh(geom, mat));
    } else {
      kind = 'pointcloud';
      const mat = new THREE.PointsMaterial({
        size: initialPointSize,
        sizeAttenuation: true,
        vertexColors: true,
        map: pointSpriteTex,
        alphaTest: 0.5,
      });
      contentHolder.add(new THREE.Points(geom, mat));
    }
  } else if (ext === '.xyz') {
    kind = 'pointcloud';
    const mat = new THREE.PointsMaterial({
      size: initialPointSize,
      sizeAttenuation: true,
      vertexColors: true,
      map: pointSpriteTex,
      alphaTest: 0.5,
    });
    const parsed = await parseAsciiPointCloudStream(
      resp,
      contentHolder,
      mat,
      maxPoints,
      handleStreamDownloadProgress
    );
    totalSourcePoints = parsed.totalFilePoints;
    sourceOrigin.copy(parsed.origin);
    lastKnownLoadedBytes = parsed.loadedBytes;
    lastKnownTotalBytes = parsed.totalBytes;
  } else if (ext === '.pcd') {
    kind = 'pointcloud';
    const { buffer, loadedBytes, totalBytes } = await readResponseBufferWithProgress(
      resp,
      handleBufferDownloadProgress
    );
    emitProgress({
      percent: 76,
      loadedBytes,
      totalBytes,
      stage: 'parsing',
      stageLabel: 'Procesando nube de puntos PCD...',
    });
    await yieldToUiFrame();
    const loader = new PCDLoader();
    const pts = loader.parse(buffer);
    const mat = pts.material as THREE.PointsMaterial;
    mat.size = initialPointSize;
    mat.sizeAttenuation = true;
    mat.map = pointSpriteTex;
    mat.alphaTest = 0.5;
    mat.needsUpdate = true;
    contentHolder.add(pts);
  } else if (ext === '.las') {
    kind = 'pointcloud';
    const mat = new THREE.PointsMaterial({
      size: initialPointSize,
      sizeAttenuation: true,
      vertexColors: true,
      map: pointSpriteTex,
      alphaTest: 0.5,
    });
    const parsed = await parseBinaryLasStream(
      resp,
      contentHolder,
      mat,
      maxPoints,
      handleStreamDownloadProgress
    );
    totalSourcePoints = parsed.totalFilePoints;
    sourceOrigin.copy(parsed.origin);
    lastKnownLoadedBytes = parsed.loadedBytes;
    lastKnownTotalBytes = parsed.totalBytes;
  } else if (ext === '.csv' || ext === '.txt' || ext === '.pts') {
    kind = 'pointcloud';
    const mat = new THREE.PointsMaterial({
      size: initialPointSize,
      sizeAttenuation: true,
      vertexColors: true,
      map: pointSpriteTex,
      alphaTest: 0.5,
    });
    const parsed = await parseAsciiPointCloudStream(
      resp,
      contentHolder,
      mat,
      maxPoints,
      handleStreamDownloadProgress
    );
    totalSourcePoints = parsed.totalFilePoints;
    sourceOrigin.copy(parsed.origin);
    lastKnownLoadedBytes = parsed.loadedBytes;
    lastKnownTotalBytes = parsed.totalBytes;
  } else {
    pointSpriteTex.dispose();
    throw new Error(`Extensión 3D no soportada (${ext}).`);
  }

  let totalCount = 0;
  const rawBoundsMin = new THREE.Vector3();
  const rawBoundsMax = new THREE.Vector3();
  let normalizedHeightSpan = 40;
  const cadTransform = {
    sourceOrigin: { x: 0, y: 0, z: 0 },
    center: { x: 0, y: 0, z: 0 },
    boxMinY: 0,
    scaleFactor: 1,
    zUp: defaultZUp,
    cadMin: { x: 0, y: 0, z: 0 },
    cadMax: { x: 0, y: 0, z: 0 },
  };

  const applyTransformAndColors = (zUp: boolean) => {
    contentHolder.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0);
    contentHolder.position.set(0, 0, 0);
    contentHolder.scale.setScalar(1);
    contentHolder.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(contentHolder);
    if (box.isEmpty()) {
      throw new Error('El modelo 3D está vacío o no contiene geometría.');
    }

    const verticalOffset = zUp ? sourceOrigin.z : sourceOrigin.y;
    rawBoundsMin.copy(box.min);
    rawBoundsMax.copy(box.max);
    rawBoundsMin.y += verticalOffset;
    rawBoundsMax.y += verticalOffset;

    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const maxHoriz = Math.max(size.x, size.z, 1e-4);
    const targetSpan = TERRAIN_SPAN_M * 0.92;
    const scaleFactor = targetSpan / maxHoriz;

    cadTransform.sourceOrigin = { x: sourceOrigin.x, y: sourceOrigin.y, z: sourceOrigin.z };
    cadTransform.center = { x: center.x, y: center.y, z: center.z };
    cadTransform.boxMinY = box.min.y;
    cadTransform.scaleFactor = scaleFactor;
    cadTransform.zUp = zUp;
    if (zUp) {
      cadTransform.cadMin = {
        x: box.min.x + sourceOrigin.x,
        y: -box.max.z + sourceOrigin.y,
        z: box.min.y + sourceOrigin.z,
      };
      cadTransform.cadMax = {
        x: box.max.x + sourceOrigin.x,
        y: -box.min.z + sourceOrigin.y,
        z: box.max.y + sourceOrigin.z,
      };
    } else {
      cadTransform.cadMin = {
        x: box.min.x + sourceOrigin.x,
        y: box.min.y + sourceOrigin.y,
        z: box.min.z + sourceOrigin.z,
      };
      cadTransform.cadMax = {
        x: box.max.x + sourceOrigin.x,
        y: box.max.y + sourceOrigin.y,
        z: box.max.z + sourceOrigin.z,
      };
    }

    contentHolder.scale.setScalar(scaleFactor);
    contentHolder.position.set(
      -center.x * scaleFactor,
      -box.min.y * scaleFactor,
      -center.z * scaleFactor
    );
    contentHolder.updateMatrixWorld(true);

    const normBox = new THREE.Box3().setFromObject(contentHolder);
    normalizedHeightSpan = Math.max(1e-4, normBox.max.y - normBox.min.y);

    // Update hypsometric colors based on normalized world Y
    meshes.length = 0;
    pointClouds.length = 0;
    totalCount = 0;
    hasTextures = false;

    const minY = normBox.min.y;
    const spanY = Math.max(1e-4, normBox.max.y - normBox.min.y);
    const vTmp = new THREE.Vector3();

    contentHolder.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const geom = obj.geometry as THREE.BufferGeometry;
        const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
        if (!pos) return;
        totalCount += pos.count;
        obj.castShadow = !isSoftwareGl;
        obj.receiveShadow = !isSoftwareGl;

        const baseMat = obj.material;
        const mats = Array.isArray(baseMat) ? baseMat : [baseMat];
        mats.forEach((m) => {
          const std = m as THREE.MeshStandardMaterial;
          const texSlots = [
            std.map,
            std.normalMap,
            std.roughnessMap,
            std.metalnessMap,
            std.emissiveMap,
            std.aoMap,
          ];
          texSlots.forEach((tex) => {
            if (tex) {
              tex.anisotropy = maxAnisotropy;
              tex.needsUpdate = true;
            }
          });
        });
        const hasEmbeddedMap = mats.some((m) => (m as THREE.MeshStandardMaterial).map != null);
        if (hasEmbeddedMap) {
          hasTextures = true;
        }

        // Prepare hypsometric vertex color clone attribute if not built yet
        if (!geom.userData._hypsoPrepared) {
          const hypsoArr = new Float32Array(pos.count * 3);
          for (let i = 0; i < pos.count; i++) {
            vTmp.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
            const t = (vTmp.y - minY) / spanY;
            const [r, g, b] = hypsometricNormalizedRgb(t);
            hypsoArr[i * 3] = r;
            hypsoArr[i * 3 + 1] = g;
            hypsoArr[i * 3 + 2] = b;
          }
          geom.userData._origColor = geom.attributes.color || null;
          geom.userData._hypsoColorAttr = new THREE.BufferAttribute(hypsoArr, 3);
          geom.userData._hypsoPrepared = true;
        }

        const hypsoMat = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.72,
          metalness: 0.06,
        });
        meshes.push({
          mesh: obj,
          baseMaterial: baseMat,
          hypsoMaterial: hypsoMat,
          orthoMaterial: null,
          hasEmbeddedMap,
        });
      } else if (obj instanceof THREE.Points) {
        kind = 'pointcloud';
        const geom = obj.geometry as THREE.BufferGeometry;
        const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
        if (!pos) return;
        totalCount += pos.count;

        if (geom.userData._origPointColorAttr === undefined) {
          geom.userData._origPointColorAttr =
            (geom.attributes.color as THREE.BufferAttribute | undefined) ?? null;
        }
        const origColorAttr = geom.userData._origPointColorAttr as THREE.BufferAttribute | null;
        if (origColorAttr) hasTextures = true;

        const buildHypsoAttr = (): THREE.BufferAttribute => {
          const hypsoBytes = new Uint8Array(pos.count * 3);
          const matWorld = obj.matrixWorld;
          for (let i = 0; i < pos.count; i++) {
            vTmp.fromBufferAttribute(pos, i).applyMatrix4(matWorld);
            const t = (vTmp.y - minY) / spanY;
            const [r, g, b] = hypsometricNormalizedRgb(t);
            hypsoBytes[i * 3] = Math.round(r * 255);
            hypsoBytes[i * 3 + 1] = Math.round(g * 255);
            hypsoBytes[i * 3 + 2] = Math.round(b * 255);
          }
          return new THREE.Uint8BufferAttribute(hypsoBytes, 3, true);
        };

        let hypsoColorAttr: THREE.BufferAttribute | null = null;
        if (!origColorAttr) {
          hypsoColorAttr = buildHypsoAttr();
          geom.setAttribute('color', hypsoColorAttr);
        }

        const mat = obj.material as THREE.PointsMaterial;
        mat.vertexColors = true;
        pointClouds.push({
          points: obj,
          originalColorAttr: origColorAttr,
          hypsoColorAttr,
          orthoColorAttr: null,
          orthoColorKey: null,
          buildHypsoAttr,
          material: mat,
        });
      }
    });
  };

  emitProgress({
    percent: 90,
    loadedBytes: lastKnownLoadedBytes,
    totalBytes: lastKnownTotalBytes,
    stage: 'geometry',
    stageLabel: 'Normalizando coordenadas, escala y colores...',
  });
  await yieldToUiFrame();

  applyTransformAndColors(defaultZUp);

  let currentHypso = false;
  let currentWireframe = false;
  let activeOrthoTex: THREE.Texture | null = null;
  let activeOrthoBounds: PlanCoordinateBounds | null = null;
  let activeOrthoCanvas: HTMLCanvasElement | null = null;
  let orthoCanvasIdCounter = 0;
  const orthoCanvasIds = new WeakMap<HTMLCanvasElement, number>();

  const getOrthoSignature = (
    canvas: HTMLCanvasElement | null,
    bounds: PlanCoordinateBounds | null
  ): string | null => {
    if (!canvas) return null;
    let cid = orthoCanvasIds.get(canvas);
    if (!cid) {
      orthoCanvasIdCounter += 1;
      cid = orthoCanvasIdCounter;
      orthoCanvasIds.set(canvas, cid);
    }
    const bKey = bounds
      ? `${bounds.minE.toFixed(2)},${bounds.maxE.toFixed(2)},${bounds.minN.toFixed(2)},${bounds.maxN.toFixed(2)}`
      : 'no-bounds';
    return `${cid}:${bKey}:${cadTransform.zUp ? 'z' : 'y'}`;
  };

  const syncMaterialsAndColors = () => {
    const fallbackBox = new THREE.Box3().setFromObject(contentHolder);
    const fallbackBounds = {
      minX: fallbackBox.min.x,
      maxX: fallbackBox.max.x,
      minZ: fallbackBox.min.z,
      maxZ: fallbackBox.max.z,
    };

    meshes.forEach((m) => {
      const geom = m.mesh.geometry as THREE.BufferGeometry;
      if (currentHypso) {
        if (geom.userData._hypsoColorAttr) {
          geom.setAttribute('color', geom.userData._hypsoColorAttr);
        }
        m.mesh.material = m.hypsoMaterial;
      } else {
        if (geom.userData._origColor) {
          geom.setAttribute('color', geom.userData._origColor);
        } else {
          geom.deleteAttribute('color');
        }

        if (!m.hasEmbeddedMap && activeOrthoTex) {
          const sig = getOrthoSignature(activeOrthoCanvas, activeOrthoBounds) ?? 'tex-only';
          if (geom.userData._orthoUvSig !== sig) {
            const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
            if (pos) {
              if (geom.userData._origUv === undefined) {
                geom.userData._origUv = geom.attributes.uv ?? null;
              }
              const uvArr = new Float32Array(pos.count * 2);
              m.mesh.updateWorldMatrix(true, false);
              const matWorld = m.mesh.matrixWorld;
              const vTmp = new THREE.Vector3();
              for (let i = 0; i < pos.count; i++) {
                vTmp.fromBufferAttribute(pos, i).applyMatrix4(matWorld);
                const [u, v] = computePlanarOrthoUv(
                  vTmp.x,
                  vTmp.z,
                  cadTransform,
                  activeOrthoBounds,
                  fallbackBounds
                );
                uvArr[i * 2] = u;
                uvArr[i * 2 + 1] = v;
              }
              geom.userData._orthoUvAttr = new THREE.BufferAttribute(uvArr, 2);
              geom.userData._orthoUvSig = sig;
            }
          }
          if (geom.userData._orthoUvAttr) {
            geom.setAttribute('uv', geom.userData._orthoUvAttr);
          }
          if (!m.orthoMaterial) {
            m.orthoMaterial = new THREE.MeshStandardMaterial({
              map: activeOrthoTex,
              roughness: 0.85,
              metalness: 0.04,
              side: THREE.DoubleSide,
            });
          } else if (m.orthoMaterial.map !== activeOrthoTex) {
            m.orthoMaterial.map = activeOrthoTex;
            m.orthoMaterial.needsUpdate = true;
          }
          m.mesh.material = m.orthoMaterial;
        } else {
          if (geom.userData._origUv) {
            geom.setAttribute('uv', geom.userData._origUv);
          }
          m.mesh.material = m.baseMaterial;
        }
      }

      const mats = Array.isArray(m.mesh.material) ? m.mesh.material : [m.mesh.material];
      mats.forEach((mat) => {
        if ('wireframe' in mat) {
          (mat as THREE.MeshStandardMaterial).wireframe = currentWireframe;
        }
      });
    });

    // Point clouds: RGB / Ortho sampled / Hypsometric
    let sampledImgData: ImageData | null = null;
    const ensureOrthoPixels = (): ImageData | null => {
      if (sampledImgData) return sampledImgData;
      if (!activeOrthoCanvas) return null;
      const ctx2d = activeOrthoCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx2d) return null;
      sampledImgData = ctx2d.getImageData(
        0,
        0,
        activeOrthoCanvas.width,
        activeOrthoCanvas.height
      );
      return sampledImgData;
    };

    pointClouds.forEach((pc) => {
      const geom = pc.points.geometry as THREE.BufferGeometry;
      if (currentHypso) {
        if (!pc.hypsoColorAttr) {
          pc.hypsoColorAttr = pc.buildHypsoAttr();
        }
        geom.setAttribute('color', pc.hypsoColorAttr);
        return;
      }

      if (pc.originalColorAttr) {
        geom.setAttribute('color', pc.originalColorAttr);
        return;
      }

      if (activeOrthoTex && activeOrthoCanvas) {
        const sig = getOrthoSignature(activeOrthoCanvas, activeOrthoBounds);
        if (pc.orthoColorKey !== sig) {
          const img = ensureOrthoPixels();
          const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
          if (img && pos) {
            const w = img.width;
            const h = img.height;
            const pxData = img.data;
            const bytes = new Uint8Array(pos.count * 3);
            pc.points.updateWorldMatrix(true, false);
            const matWorld = pc.points.matrixWorld;
            const vTmp = new THREE.Vector3();
            for (let i = 0; i < pos.count; i++) {
              vTmp.fromBufferAttribute(pos, i).applyMatrix4(matWorld);
              const [u, v] = computePlanarOrthoUv(
                vTmp.x,
                vTmp.z,
                cadTransform,
                activeOrthoBounds,
                fallbackBounds
              );
              const px = Math.max(0, Math.min(w - 1, Math.round(u * (w - 1))));
              const py = Math.max(0, Math.min(h - 1, Math.round((1 - v) * (h - 1))));
              const pIdx = (py * w + px) * 4;
              bytes[i * 3] = SRGB_U8_TO_LINEAR_U8[pxData[pIdx]];
              bytes[i * 3 + 1] = SRGB_U8_TO_LINEAR_U8[pxData[pIdx + 1]];
              bytes[i * 3 + 2] = SRGB_U8_TO_LINEAR_U8[pxData[pIdx + 2]];
            }
            pc.orthoColorAttr = new THREE.Uint8BufferAttribute(bytes, 3, true);
            pc.orthoColorKey = sig;
          }
        }
        if (pc.orthoColorAttr) {
          geom.setAttribute('color', pc.orthoColorAttr);
          return;
        }
      }

      if (!pc.hypsoColorAttr) {
        pc.hypsoColorAttr = pc.buildHypsoAttr();
      }
      geom.setAttribute('color', pc.hypsoColorAttr);
    });
  };

  emitProgress({
    percent: 96,
    loadedBytes: lastKnownLoadedBytes,
    totalBytes: lastKnownTotalBytes,
    stage: 'finalizing',
    stageLabel: 'Subiendo escena a WebGL...',
  });

  return {
    group: rootGroup,
    kind,
    pointOrVertexCount: totalCount,
    totalSourcePoints,
    rawBoundsMin,
    rawBoundsMax,
    get normalizedHeightSpan() {
      return normalizedHeightSpan;
    },
    cadTransform,
    get hasTextures() {
      return hasTextures || Boolean(activeOrthoTex);
    },
    setHypsometricMode: (enabled: boolean) => {
      currentHypso = enabled;
      syncMaterialsAndColors();
    },
    setWireframeMode: (enabled: boolean) => {
      currentWireframe = enabled;
      syncMaterialsAndColors();
    },
    setOrthophotoOverlay: (
      texture: THREE.Texture | null,
      orthoBounds: PlanCoordinateBounds | null = null,
      orthoCanvas: HTMLCanvasElement | null = null
    ) => {
      activeOrthoTex = texture;
      activeOrthoBounds = orthoBounds;
      activeOrthoCanvas = orthoCanvas;
      syncMaterialsAndColors();
    },
    setZUpOrientation: (zUp: boolean) => {
      // Clear cached hypsometric & ortho UV attributes so they recompute cleanly for new vertical axis
      contentHolder.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.userData._hypsoPrepared = false;
          obj.geometry.userData._orthoUvSig = null;
        }
      });
      applyTransformAndColors(zUp);
      syncMaterialsAndColors();
    },
    setPointSize: (size: number) => {
      const clamped = Math.max(0.1, Math.min(8, size));
      pointClouds.forEach((pc) => {
        pc.material.size = clamped;
      });
    },
    dispose: () => {
      contentHolder.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((mat) => {
            const std = mat as THREE.MeshStandardMaterial;
            if (std.map && std.map !== pointSpriteTex && std.map !== activeOrthoTex) {
              std.map.dispose();
            }
            mat.dispose();
          });
        }
      });
      pointSpriteTex.dispose();
      meshes.forEach((m) => {
        m.hypsoMaterial.dispose();
        if (m.orthoMaterial) {
          m.orthoMaterial.dispose();
        }
      });
      for (const bUrl of tempBlobUrls) {
        try {
          URL.revokeObjectURL(bUrl);
        } catch {
          // ignore
        }
      }
    },
  };
}

export function parseWorldFileBounds(
  worldText: string,
  widthPx: number,
  heightPx: number
): PlanCoordinateBounds | null {
  if (!worldText || widthPx <= 0 || heightPx <= 0) return null;
  const nums = worldText
    .trim()
    .split(/\s+/)
    .map((v) => Number(v.replace(',', '.')))
    .filter((v) => Number.isFinite(v));
  if (nums.length < 6) return null;
  const [A, D, B, E, C, F] = nums;
  const det = A * E - B * D;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;

  // World files reference center of top-left pixel (0, 0); shift by -0.5 pixel to outer top-left corner
  const d = C - 0.5 * A - 0.5 * B;
  const h = F - 0.5 * D - 0.5 * E;
  const corners: Array<[number, number]> = [
    [0, 0],
    [widthPx, 0],
    [0, heightPx],
    [widthPx, heightPx],
  ];
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const [px, py] of corners) {
    const cx = A * px + B * py + d;
    const cy = D * px + E * py + h;
    if (cx < minE) minE = cx;
    if (cx > maxE) maxE = cx;
    if (cy < minN) minN = cy;
    if (cy > maxN) maxN = cy;
  }
  if (!Number.isFinite(minE) || !Number.isFinite(maxE) || !Number.isFinite(minN) || !Number.isFinite(maxN)) {
    return null;
  }
  if (maxE <= minE || maxN <= minN) return null;
  return {
    minE,
    maxE,
    minN,
    maxN,
    source: 'geotiff',
    geoAffine: {
      a: A,
      b: B,
      d,
      e: D,
      f: E,
      h,
      widthPx,
      heightPx,
    },
  };
}

export function extractGeoTiffBounds(
  buffer: ArrayBuffer,
  widthPx: number,
  heightPx: number
): PlanCoordinateBounds | null {
  if (buffer.byteLength < 16 || widthPx <= 0 || heightPx <= 0) return null;
  try {
    const view = new DataView(buffer);
    const endian = view.getUint16(0, false);
    const littleEndian = endian === 0x4949 ? true : endian === 0x4d4d ? false : null;
    if (littleEndian === null) return null;

    const magic = view.getUint16(2, littleEndian);
    if (magic !== 42) return null;

    const readNumericArray = (type: number, count: number, valueOffset: number, inlineOffset: number): number[] | null => {
      if (count <= 0) return null;
      if (type === 12) {
        const bytes = count * 8;
        const off = bytes <= 4 ? inlineOffset : valueOffset;
        if (off < 0 || off + bytes > buffer.byteLength) return null;
        const out: number[] = [];
        for (let i = 0; i < count; i++) out.push(view.getFloat64(off + i * 8, littleEndian));
        return out;
      }
      if (type === 11) {
        const bytes = count * 4;
        const off = bytes <= 4 ? inlineOffset : valueOffset;
        if (off < 0 || off + bytes > buffer.byteLength) return null;
        const out: number[] = [];
        for (let i = 0; i < count; i++) out.push(view.getFloat32(off + i * 4, littleEndian));
        return out;
      }
      return null;
    };

    const readShortArray = (type: number, count: number, valueOffset: number, inlineOffset: number): number[] | null => {
      if (type !== 3 || count <= 0) return null;
      const bytes = count * 2;
      const off = bytes <= 4 ? inlineOffset : valueOffset;
      if (off < 0 || off + bytes > buffer.byteLength) return null;
      const out: number[] = [];
      for (let i = 0; i < count; i++) out.push(view.getUint16(off + i * 2, littleEndian));
      return out;
    };

    let ifdOffset = view.getUint32(4, littleEndian);
    let visited = 0;
    while (ifdOffset > 0 && ifdOffset + 2 <= buffer.byteLength && visited < 8) {
      visited++;
      const entryCount = view.getUint16(ifdOffset, littleEndian);
      let pixelScale: number[] | null = null;
      let tiepoints: number[] | null = null;
      let modelTransform: number[] | null = null;
      let geoKeys: number[] | null = null;

      for (let i = 0; i < entryCount; i++) {
        const entryOff = ifdOffset + 2 + i * 12;
        if (entryOff + 12 > buffer.byteLength) break;
        const tag = view.getUint16(entryOff, littleEndian);
        const type = view.getUint16(entryOff + 2, littleEndian);
        const count = view.getUint32(entryOff + 4, littleEndian);
        const valOff = view.getUint32(entryOff + 8, littleEndian);
        const inlineOff = entryOff + 8;

        if (tag === 33550) {
          pixelScale = readNumericArray(type, count, valOff, inlineOff);
        } else if (tag === 33922) {
          tiepoints = readNumericArray(type, count, valOff, inlineOff);
        } else if (tag === 34264) {
          modelTransform = readNumericArray(type, count, valOff, inlineOff);
        } else if (tag === 34735) {
          geoKeys = readShortArray(type, count, valOff, inlineOff);
        }
      }

      // Check GTRasterTypeGeoKey (1025): 2 = RasterPixelIsPoint (half-pixel shift vs RasterPixelIsArea)
      let isPixelIsPoint = false;
      if (geoKeys && geoKeys.length >= 4) {
        const numKeys = geoKeys[3];
        for (let k = 0; k < numKeys; k++) {
          const base = 4 + k * 4;
          if (base + 3 >= geoKeys.length) break;
          if (geoKeys[base] === 1025 && geoKeys[base + 1] === 0 && geoKeys[base + 3] === 2) {
            isPixelIsPoint = true;
            break;
          }
        }
      }

      if (modelTransform && modelTransform.length >= 8) {
        const a = modelTransform[0];
        const b = modelTransform[1];
        const dRaw = modelTransform[3];
        const e = modelTransform[4];
        const f = modelTransform[5];
        const hRaw = modelTransform[7];
        const det = a * f - b * e;
        if (Number.isFinite(det) && Math.abs(det) > 1e-18) {
          const d = isPixelIsPoint ? dRaw - 0.5 * a - 0.5 * b : dRaw;
          const h = isPixelIsPoint ? hRaw - 0.5 * e - 0.5 * f : hRaw;
          const corners: Array<[number, number]> = [
            [0, 0],
            [widthPx, 0],
            [0, heightPx],
            [widthPx, heightPx],
          ];
          let minE = Infinity;
          let maxE = -Infinity;
          let minN = Infinity;
          let maxN = -Infinity;
          for (const [px, py] of corners) {
            const cx = a * px + b * py + d;
            const cy = e * px + f * py + h;
            if (cx < minE) minE = cx;
            if (cx > maxE) maxE = cx;
            if (cy < minN) minN = cy;
            if (cy > maxN) maxN = cy;
          }
          if (
            Number.isFinite(minE) &&
            Number.isFinite(maxE) &&
            Number.isFinite(minN) &&
            Number.isFinite(maxN) &&
            maxE > minE &&
            maxN > minN
          ) {
            return {
              minE,
              maxE,
              minN,
              maxN,
              source: 'geotiff',
              geoAffine: { a, b, d, e, f, h, widthPx, heightPx },
            };
          }
        }
      }

      if (pixelScale && pixelScale.length >= 2 && tiepoints && tiepoints.length >= 6) {
        const sx = Math.abs(pixelScale[0]);
        const sy = Math.abs(pixelScale[1]);
        const i = tiepoints[0] + (isPixelIsPoint ? 0.5 : 0);
        const j = tiepoints[1] + (isPixelIsPoint ? 0.5 : 0);
        const x = tiepoints[3];
        const y = tiepoints[4];
        if (sx > 0 && sy > 0 && Number.isFinite(x) && Number.isFinite(y)) {
          const d = x - i * sx;
          const h = y + j * sy;
          const minE = d;
          const maxE = d + widthPx * sx;
          const maxN = h;
          const minN = h - heightPx * sy;
          if (
            Number.isFinite(minE) &&
            Number.isFinite(maxE) &&
            Number.isFinite(minN) &&
            Number.isFinite(maxN) &&
            maxE > minE &&
            maxN > minN
          ) {
            return {
              minE,
              maxE,
              minN,
              maxN,
              source: 'geotiff',
              geoAffine: { a: sx, b: 0, d, e: 0, f: -sy, h, widthPx, heightPx },
            };
          }
        }
      }

      const nextIfdPtr = ifdOffset + 2 + entryCount * 12;
      if (nextIfdPtr + 4 > buffer.byteLength) break;
      ifdOffset = view.getUint32(nextIfdPtr, littleEndian);
    }
  } catch {
    return null;
  }
  return null;
}

export async function loadOrthophotoDataFromUrl(
  url: string,
  fileName: string
): Promise<LoadedOrthophotoResult> {
  const ext = getFileExtension(fileName);
  if (ext === '.tif' || ext === '.tiff') {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('No se pudo cargar la ortofoto GeoTIFF.');
    const buf = await resp.arrayBuffer();
    const loader = new TIFFLoader();
    const dataTex = loader.parse(buf) as unknown as {
      width?: number;
      height?: number;
      data?: Uint8Array | Uint16Array | Float32Array;
      image?: { width: number; height: number; data: Uint8Array | Uint16Array | Float32Array };
    };
    const img = dataTex.image ?? {
      width: dataTex.width || 512,
      height: dataTex.height || 512,
      data: dataTex.data || new Uint8Array(0),
    };
    const rawW = img.width || 512;
    const rawH = img.height || 512;
    const geoBounds = extractGeoTiffBounds(buf, rawW, rawH);

    const rawCanvas = document.createElement('canvas');
    rawCanvas.width = rawW;
    rawCanvas.height = rawH;
    const rawCtx = rawCanvas.getContext('2d');
    if (!rawCtx || !img.data || img.data.length === 0) {
      return {
        canvas: rawCanvas,
        naturalWidth: rawW,
        naturalHeight: rawH,
        geoBounds,
      };
    }
    const out = rawCtx.createImageData(rawW, rawH);
    const src = img.data;
    const totalPx = rawW * rawH;
    const channels = Math.max(1, Math.floor(src.length / totalPx));
    const is16 = src instanceof Uint16Array;
    for (let i = 0; i < totalPx; i++) {
      const s = i * channels;
      const scale = is16 ? 1 / 257 : 1;
      out.data[i * 4] = Math.min(255, Math.round((src[s] || 0) * scale));
      out.data[i * 4 + 1] = Math.min(255, Math.round((src[channels >= 2 ? s + 1 : s] || 0) * scale));
      out.data[i * 4 + 2] = Math.min(255, Math.round((src[channels >= 3 ? s + 2 : s] || 0) * scale));
      out.data[i * 4 + 3] =
        channels >= 4 ? Math.min(255, Math.round((src[s + 3] ?? 255) * scale)) : 255;
    }
    rawCtx.putImageData(out, 0, 0);

    const maxDim = 4096;
    if (Math.max(rawW, rawH) <= maxDim) {
      return {
        canvas: rawCanvas,
        naturalWidth: rawW,
        naturalHeight: rawH,
        geoBounds,
      };
    }
    const scale = maxDim / Math.max(rawW, rawH);
    const scaled = document.createElement('canvas');
    scaled.width = Math.max(1, Math.round(rawW * scale));
    scaled.height = Math.max(1, Math.round(rawH * scale));
    const sCtx = scaled.getContext('2d');
    if (sCtx) {
      sCtx.imageSmoothingEnabled = true;
      sCtx.imageSmoothingQuality = 'high';
      sCtx.drawImage(rawCanvas, 0, 0, scaled.width, scaled.height);
    }
    return {
      canvas: scaled,
      naturalWidth: rawW,
      naturalHeight: rawH,
      geoBounds,
    };
  }

  return new Promise<LoadedOrthophotoResult>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const maxDim = 4096;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      resolve({
        canvas,
        naturalWidth: img.width,
        naturalHeight: img.height,
        geoBounds: null,
      });
    };
    img.onerror = () => reject(new Error('No se pudo decodificar la imagen de ortofoto.'));
    img.src = url;
  });
}

export async function loadOrthophotoCanvasFromUrl(
  url: string,
  fileName: string
): Promise<HTMLCanvasElement> {
  const result = await loadOrthophotoDataFromUrl(url, fileName);
  return result.canvas;
}
