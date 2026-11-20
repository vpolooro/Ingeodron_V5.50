import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Box,
  CheckCircle2,
  Eye,
  EyeOff,
  FileCode2,
  FolderUp,
  Image as ImageIcon,
  Loader2,
  Map as MapIcon,
  Mountain,
  Plane,
  RefreshCw,
  Upload,
  Waves,
} from 'lucide-react';
import { Quarry3DViewer, type External3DSource } from './Quarry3DViewer.tsx';
import { Quarry2DOrthophotoViewer } from './Quarry2DOrthophotoViewer.tsx';
import { buildQuarryTerrainData } from '../utils/quarryTerrainModel.ts';
import {
  cadTransformToPlanBounds,
  isSupported3DFileName,
  isSupportedOrthoFileName,
  loadOrthophotoDataFromUrl,
  type CadTransform,
  type LoadedOrthophotoResult,
  type PlanCoordinateBounds,
} from '../utils/threeFileLoader.ts';
import {
  isSupportedContourDxfFileName,
  loadDxfContoursFromUrl,
  type DxfContourProgressInfo,
  type ParsedDxfContours,
} from '../utils/dxfContourParser.ts';
import type { Deliverable, FlightDxfOverlay, Quarry, Stockpile, Survey, Zone } from '../types.ts';
import { formatDateEu } from '../utils/dateUtils.ts';

interface PhotogrammetryWorkspaceProps {
  quarry: Quarry | null;
  zones: Zone[];
  stockpiles: Stockpile[];
  activeFlight?: Survey;
  deliverables?: Deliverable[];
  dxfOverlay?: FlightDxfOverlay | null;
  isAdmin?: boolean;
  preferredDeliverableId?: number | null;
  onOpenUploadModal?: () => void;
  onOpenDxfSettings?: () => void;
}

function appendAuthToken(rawUrl: string): string {
  if (typeof window === 'undefined' || !rawUrl || rawUrl.startsWith('blob:') || rawUrl.startsWith('data:')) {
    return rawUrl;
  }
  const token = localStorage.getItem('ingeodron_token');
  if (!token) return rawUrl;
  const separator = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${separator}token=${encodeURIComponent(token)}`;
}

function buildDeliverableAssetUrl(d: Deliverable): string {
  if (d.shareUrl) return appendAuthToken(d.shareUrl);
  const inlineUrl = d.fileUrl.includes('?') ? `${d.fileUrl}&inline=1` : `${d.fileUrl}?inline=1`;
  return appendAuthToken(inlineUrl);
}

function hasAvailableUploadedFile(d: Deliverable): boolean {
  return d.isServerStored ? Boolean(d.hasPhysicalFile) : Boolean(d.hasPhysicalFile || d.shareUrl);
}

function sortDeliverablesForContext(items: Deliverable[], activeFlightId?: number): Deliverable[] {
  return [...items].sort((a, b) => {
    const aMatchesFlight = activeFlightId ? Number(a.surveyId) === activeFlightId : false;
    const bMatchesFlight = activeFlightId ? Number(b.surveyId) === activeFlightId : false;
    if (aMatchesFlight !== bMatchesFlight) return aMatchesFlight ? -1 : 1;

    const aDate = String(a.createdAt || a.uploadDate || '');
    const bDate = String(b.createdAt || b.uploadDate || '');
    if (aDate !== bDate) return bDate.localeCompare(aDate);

    return Number(b.id) - Number(a.id);
  });
}

export const PhotogrammetryWorkspace: React.FC<PhotogrammetryWorkspaceProps> = ({
  quarry,
  zones,
  stockpiles,
  activeFlight,
  deliverables = [],
  dxfOverlay = null,
  isAdmin = false,
  preferredDeliverableId = null,
  onOpenUploadModal,
  onOpenDxfSettings,
}) => {
  const [viewerMode, setViewerMode] = useState<'3d' | '2d'>('3d');
  const [showDxfOverlay, setShowDxfOverlay] = useState<boolean>(true);
  const [dxfOpacity, setDxfOpacity] = useState<number>(0.48);

  // Server deliverables strictly scoped to the single active quarry & physically available
  const quarryScopedDeliverables = useMemo(() => {
    if (!quarry || quarry.id <= 0) return [];
    return deliverables.filter((d) => d.quarryId === quarry.id && hasAvailableUploadedFile(d));
  }, [deliverables, quarry]);

  // Server deliverables compatible with 3D Viewer & 2D Orthophoto (active flight first, then newest)
  const compatible3DDeliverables = useMemo(
    () =>
      sortDeliverablesForContext(
        quarryScopedDeliverables.filter((d) => isSupported3DFileName(d.fileName)),
        activeFlight?.id
      ),
    [quarryScopedDeliverables, activeFlight?.id]
  );

  const compatibleOrthoDeliverables = useMemo(
    () =>
      sortDeliverablesForContext(
        quarryScopedDeliverables.filter((d) => isSupportedOrthoFileName(d.fileName)),
        activeFlight?.id
      ),
    [quarryScopedDeliverables, activeFlight?.id]
  );

  const compatibleContourDxfDeliverables = useMemo(
    () =>
      sortDeliverablesForContext(
        quarryScopedDeliverables.filter(
          (d) => d.category === 'contour_dxf' || isSupportedContourDxfFileName(d.fileName)
        ),
        activeFlight?.id
      ),
    [quarryScopedDeliverables, activeFlight?.id]
  );

  const [selected3DKey, setSelected3DKey] = useState<string>('');
  const [selectedOrthoKey, setSelectedOrthoKey] = useState<string>('');
  const [selectedContourDxfKey, setSelectedContourDxfKey] = useState<string>('');
  const [local3DPreview, setLocal3DPreview] = useState<External3DSource | null>(null);
  const [localOrthoFile, setLocalOrthoFile] = useState<{ url: string; fileName: string } | null>(null);
  const [localContourDxfFile, setLocalContourDxfFile] = useState<{ url: string; fileName: string } | null>(null);
  const [loadedOrthophoto, setLoadedOrthophoto] = useState<LoadedOrthophotoResult | null>(null);
  const [loadedContourDxf, setLoadedContourDxf] = useState<ParsedDxfContours | null>(null);
  const [loaded3DCadTransform, setLoaded3DCadTransform] = useState<CadTransform | null>(null);
  const [orthoLoading, setOrthoLoading] = useState<boolean>(false);
  const [orthoError, setOrthoError] = useState<string | null>(null);
  const [orthoReloadTick, setOrthoReloadTick] = useState<number>(0);
  const [contourDxfLoading, setContourDxfLoading] = useState<boolean>(false);
  const [contourDxfProgress, setContourDxfProgress] = useState<DxfContourProgressInfo | null>(null);
  const [contourDxfError, setContourDxfError] = useState<string | null>(null);
  const [showDxfContours, setShowDxfContours] = useState<boolean>(true);
  const [localHintError, setLocalHintError] = useState<string | null>(null);
  const [localSuccessNotice, setLocalSuccessNotice] = useState<string | null>(null);

  const lastFlightId3DRef = useRef<number | undefined>(activeFlight?.id);
  const lastFlightIdOrthoRef = useRef<number | undefined>(activeFlight?.id);
  const lastFlightIdContourRef = useRef<number | undefined>(activeFlight?.id);

  // Reset local overrides and errors when switching to another quarry
  useEffect(() => {
    setSelected3DKey('');
    setSelectedOrthoKey('');
    setSelectedContourDxfKey('');
    setLocal3DPreview(null);
    setLocalOrthoFile(null);
    setLocalContourDxfFile(null);
    setLoadedOrthophoto(null);
    setLoadedContourDxf(null);
    setLoaded3DCadTransform(null);
    setOrthoLoading(false);
    setOrthoError(null);
    setContourDxfLoading(false);
    setContourDxfProgress(null);
    setContourDxfError(null);
    setLocalHintError(null);
    setLocalSuccessNotice(null);
    lastFlightId3DRef.current = activeFlight?.id;
    lastFlightIdOrthoRef.current = activeFlight?.id;
    lastFlightIdContourRef.current = activeFlight?.id;
  }, [quarry?.id]);

  // Clear stale 3D coordinate bounds whenever the selected 3D source changes
  useEffect(() => {
    setLoaded3DCadTransform(null);
  }, [selected3DKey]);

  // Auto-select newly uploaded 3D, Orthophoto, or Contour DXF deliverable when uploaded from this workspace
  useEffect(() => {
    if (!preferredDeliverableId) return;
    const d3 = compatible3DDeliverables.find((d) => d.id === preferredDeliverableId);
    if (d3) {
      setSelected3DKey(`deliv:${d3.id}`);
      return;
    }
    const dO = compatibleOrthoDeliverables.find((d) => d.id === preferredDeliverableId);
    if (dO) {
      setSelectedOrthoKey(`deliv:${dO.id}`);
      return;
    }
    const dC = compatibleContourDxfDeliverables.find((d) => d.id === preferredDeliverableId);
    if (dC) {
      setSelectedContourDxfKey(`deliv:${dC.id}`);
      setShowDxfContours(true);
    }
  }, [preferredDeliverableId, compatible3DDeliverables, compatibleOrthoDeliverables, compatibleContourDxfDeliverables]);

  // Automatically load the client's uploaded 3D model deliverable (prioritizing active flight)
  useEffect(() => {
    const flightChanged = lastFlightId3DRef.current !== activeFlight?.id;
    lastFlightId3DRef.current = activeFlight?.id;

    if (selected3DKey === 'local' && isAdmin && local3DPreview && !flightChanged) {
      return;
    }

    if (compatible3DDeliverables.length === 0) {
      if (!(selected3DKey === 'local' && isAdmin && local3DPreview)) {
        setSelected3DKey('');
      }
      return;
    }

    const currentId = selected3DKey.startsWith('deliv:') ? Number(selected3DKey.slice(6)) : NaN;
    const currentExists = Number.isFinite(currentId) && compatible3DDeliverables.some((d) => d.id === currentId);

    if (!currentExists || flightChanged) {
      setSelected3DKey(`deliv:${compatible3DDeliverables[0].id}`);
    }
  }, [compatible3DDeliverables, activeFlight?.id, selected3DKey, isAdmin, local3DPreview]);

  // Automatically load the client's uploaded 2D orthophoto deliverable (prioritizing active flight)
  useEffect(() => {
    const flightChanged = lastFlightIdOrthoRef.current !== activeFlight?.id;
    lastFlightIdOrthoRef.current = activeFlight?.id;

    if (selectedOrthoKey === 'local' && isAdmin && localOrthoFile && !flightChanged) {
      return;
    }

    if (compatibleOrthoDeliverables.length === 0) {
      if (!(selectedOrthoKey === 'local' && isAdmin && localOrthoFile)) {
        setSelectedOrthoKey('');
      }
      return;
    }

    const currentId = selectedOrthoKey.startsWith('deliv:') ? Number(selectedOrthoKey.slice(6)) : NaN;
    const currentExists = Number.isFinite(currentId) && compatibleOrthoDeliverables.some((d) => d.id === currentId);

    if (!currentExists || flightChanged) {
      setSelectedOrthoKey(`deliv:${compatibleOrthoDeliverables[0].id}`);
    }
  }, [compatibleOrthoDeliverables, activeFlight?.id, selectedOrthoKey, isAdmin, localOrthoFile]);

  // Automatically load the client's uploaded Contour DXF deliverable for BOTH 3D & 2D viewers
  useEffect(() => {
    const flightChanged = lastFlightIdContourRef.current !== activeFlight?.id;
    lastFlightIdContourRef.current = activeFlight?.id;

    if (selectedContourDxfKey === 'local' && isAdmin && localContourDxfFile && !flightChanged) {
      return;
    }

    if (compatibleContourDxfDeliverables.length === 0) {
      if (!(selectedContourDxfKey === 'local' && isAdmin && localContourDxfFile)) {
        setSelectedContourDxfKey('');
      }
      return;
    }

    const currentId = selectedContourDxfKey.startsWith('deliv:')
      ? Number(selectedContourDxfKey.slice(6))
      : NaN;
    const currentExists =
      Number.isFinite(currentId) && compatibleContourDxfDeliverables.some((d) => d.id === currentId);

    if (!currentExists || flightChanged) {
      setSelectedContourDxfKey(`deliv:${compatibleContourDxfDeliverables[0].id}`);
      setShowDxfContours(true);
    }
  }, [compatibleContourDxfDeliverables, activeFlight?.id, selectedContourDxfKey, isAdmin, localContourDxfFile]);

  // Revoke object URLs on change/unmount
  useEffect(() => {
    return () => {
      if (local3DPreview?.url.startsWith('blob:')) {
        URL.revokeObjectURL(local3DPreview.url);
      }
    };
  }, [local3DPreview]);

  useEffect(() => {
    return () => {
      if (localOrthoFile?.url.startsWith('blob:')) {
        URL.revokeObjectURL(localOrthoFile.url);
      }
    };
  }, [localOrthoFile]);

  useEffect(() => {
    return () => {
      if (localContourDxfFile?.url.startsWith('blob:')) {
        URL.revokeObjectURL(localContourDxfFile.url);
      }
    };
  }, [localContourDxfFile]);

  const activeExternal3DSource = useMemo<External3DSource | null>(() => {
    if (selected3DKey === 'local' && isAdmin && local3DPreview) {
      return local3DPreview;
    }
    if (selected3DKey.startsWith('deliv:')) {
      const id = Number(selected3DKey.slice(6));
      const d = compatible3DDeliverables.find((item) => item.id === id);
      if (d) {
        return {
          url: buildDeliverableAssetUrl(d),
          fileName: d.fileName,
          label: d.title || d.fileName,
        };
      }
    }
    return null;
  }, [selected3DKey, isAdmin, local3DPreview, compatible3DDeliverables]);

  const activeOrthoTarget = useMemo<{ url: string; fileName: string; label: string } | null>(() => {
    if (selectedOrthoKey === 'local' && isAdmin && localOrthoFile) {
      return {
        url: localOrthoFile.url,
        fileName: localOrthoFile.fileName,
        label: `Local: ${localOrthoFile.fileName}`,
      };
    }
    if (selectedOrthoKey.startsWith('deliv:')) {
      const id = Number(selectedOrthoKey.slice(6));
      const d = compatibleOrthoDeliverables.find((item) => item.id === id);
      if (d) {
        return {
          url: buildDeliverableAssetUrl(d),
          fileName: d.fileName,
          label: d.title || d.fileName,
        };
      }
    }
    return null;
  }, [selectedOrthoKey, isAdmin, localOrthoFile, compatibleOrthoDeliverables]);

  const activeContourDxfTarget = useMemo<{ url: string; fileName: string; label: string } | null>(() => {
    if (selectedContourDxfKey === 'local' && isAdmin && localContourDxfFile) {
      return {
        url: localContourDxfFile.url,
        fileName: localContourDxfFile.fileName,
        label: `Local: ${localContourDxfFile.fileName}`,
      };
    }
    if (selectedContourDxfKey.startsWith('deliv:')) {
      const id = Number(selectedContourDxfKey.slice(6));
      const d = compatibleContourDxfDeliverables.find((item) => item.id === id);
      if (d) {
        return {
          url: buildDeliverableAssetUrl(d),
          fileName: d.fileName,
          label: d.title || d.fileName,
        };
      }
    }
    return null;
  }, [selectedContourDxfKey, isAdmin, localContourDxfFile, compatibleContourDxfDeliverables]);

  // Load selected Orthophoto canvas & GeoTIFF bounds automatically when target changes
  useEffect(() => {
    let cancelled = false;

    if (!activeOrthoTarget) {
      setLoadedOrthophoto(null);
      setOrthoLoading(false);
      setOrthoError(null);
      return;
    }

    setOrthoLoading(true);
    setOrthoError(null);
    setLoadedOrthophoto(null);

    loadOrthophotoDataFromUrl(activeOrthoTarget.url, activeOrthoTarget.fileName)
      .then((result) => {
        if (!cancelled) {
          setLoadedOrthophoto(result);
          setOrthoLoading(false);
          setOrthoError(null);
          setLocalHintError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'No se pudo cargar la ortofoto.';
          setLoadedOrthophoto(null);
          setOrthoLoading(false);
          setOrthoError(message);
          setLocalHintError(message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeOrthoTarget, orthoReloadTick]);

  // Load & parse uploaded Contour DXF automatically for BOTH 3D and 2D viewers
  useEffect(() => {
    let cancelled = false;

    if (!activeContourDxfTarget) {
      setLoadedContourDxf(null);
      setContourDxfLoading(false);
      setContourDxfProgress(null);
      setContourDxfError(null);
      return;
    }

    setContourDxfLoading(true);
    setContourDxfProgress({
      percent: 4,
      loadedBytes: 0,
      totalBytes: null,
      stage: 'downloading',
      stageLabel: 'Conectando para descargar curvado DXF...',
    });
    setContourDxfError(null);

    loadDxfContoursFromUrl(activeContourDxfTarget.url, activeContourDxfTarget.fileName, (info) => {
      if (!cancelled) {
        setContourDxfProgress(info);
      }
    })
      .then((parsed) => {
        if (!cancelled) {
          setLoadedContourDxf(parsed);
          setContourDxfLoading(false);
          setContourDxfProgress(null);
          setContourDxfError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'No se pudo procesar el DXF de curvado.';
          setLoadedContourDxf(null);
          setContourDxfLoading(false);
          setContourDxfProgress(null);
          setContourDxfError(message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeContourDxfTarget]);

  useEffect(() => {
    if (isAdmin) return;
    setLocal3DPreview(null);
    setLocalOrthoFile(null);
    setLocalContourDxfFile(null);
    setSelected3DKey((k) => (k === 'local' ? '' : k));
    setSelectedOrthoKey((k) => (k === 'local' ? '' : k));
    setSelectedContourDxfKey((k) => (k === 'local' ? '' : k));
  }, [isAdmin]);

  const handleLocalPreviewFile = (file: File | null) => {
    if (!isAdmin || !file) return;
    setLocalHintError(null);
    setLocalSuccessNotice(null);
    const lower = file.name.toLowerCase();

    if (lower.endsWith('.laz')) {
      setLocalHintError(
        'Los archivos comprimidos .LAZ deben convertirse primero a .LAS, .PLY, .XYZ, .OBJ o .GLB para cargarse directamente en el visor web.'
      );
      return;
    }

    if (isSupportedContourDxfFileName(file.name)) {
      const url = URL.createObjectURL(file);
      setLocalContourDxfFile({ url, fileName: file.name });
      setSelectedContourDxfKey('local');
      setShowDxfContours(true);
      setLocalSuccessNotice(
        `Curvado DXF cargado en ambos visores (3D y 2D): ${file.name}`
      );
      return;
    }

    if (isSupported3DFileName(file.name)) {
      const url = URL.createObjectURL(file);
      setLocal3DPreview({
        url,
        fileName: file.name,
        label: `Local: ${file.name}`,
      });
      setSelected3DKey('local');
      setViewerMode('3d');
      setLocalSuccessNotice(`Archivo 3D cargado correctamente en el visor: ${file.name}`);
      return;
    }

    if (isSupportedOrthoFileName(file.name)) {
      const url = URL.createObjectURL(file);
      setLocalOrthoFile({ url, fileName: file.name });
      setSelectedOrthoKey('local');
      setViewerMode('2d');
      setLocalSuccessNotice(`Ortofoto cargada correctamente en el visor: ${file.name}`);
      return;
    }

    setLocalHintError(
      'Formato no compatible para vista 3D/Ortofoto/Curvado. Usa .OBJ, .GLB, .GLTF, .PLY, .STL, .LAS, .XYZ, .PCD, .CSV/.TXT, ortofotos .PNG/.JPG/.TIF o curvado .DXF.'
    );
  };

  // Scope stockpiles to active flight if one is selected, otherwise latest stockpiles in quarry
  const scopedStockpiles = useMemo(() => {
    if (activeFlight) {
      const flightItems = stockpiles.filter((s) => s.surveyId === activeFlight.id);
      if (flightItems.length > 0) return flightItems;
    }
    return stockpiles;
  }, [stockpiles, activeFlight]);

  const terrain = useMemo(
    () => buildQuarryTerrainData(quarry, zones, scopedStockpiles),
    [quarry, zones, scopedStockpiles]
  );

  const resolved2DPlanBounds = useMemo<PlanCoordinateBounds | null>(() => {
    if (loadedOrthophoto?.geoBounds) {
      return loadedOrthophoto.geoBounds;
    }
    if (
      dxfOverlay?.bounds &&
      Number.isFinite(dxfOverlay.bounds.minX) &&
      Number.isFinite(dxfOverlay.bounds.maxX) &&
      Number.isFinite(dxfOverlay.bounds.minY) &&
      Number.isFinite(dxfOverlay.bounds.maxY) &&
      dxfOverlay.bounds.maxX > dxfOverlay.bounds.minX &&
      dxfOverlay.bounds.maxY > dxfOverlay.bounds.minY
    ) {
      return {
        minE: dxfOverlay.bounds.minX,
        maxE: dxfOverlay.bounds.maxX,
        minN: dxfOverlay.bounds.minY,
        maxN: dxfOverlay.bounds.maxY,
        source: 'dxf',
      };
    }
    if (loadedContourDxf?.planBounds) {
      return loadedContourDxf.planBounds;
    }
    if (loaded3DCadTransform) {
      return cadTransformToPlanBounds(loaded3DCadTransform);
    }
    return null;
  }, [loadedOrthophoto, dxfOverlay, loadedContourDxf, loaded3DCadTransform]);

  const hasAny3DSource = Boolean(activeExternal3DSource || activeContourDxfTarget);
  const hasAnyOrthoSource = Boolean(activeOrthoTarget || activeContourDxfTarget);

  return (
    <section className="flex-1 flex flex-col gap-4 min-h-0">
      {/* Header & Workspace Switcher */}
      <div className="glass-panel border border-gray-800 rounded-2xl p-4 space-y-3 shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 flex items-center justify-center shrink-0">
              <Mountain className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white flex flex-wrap items-center gap-2">
                <span>Visor Fotogramétrico 3D &amp; Planos Georreferenciados</span>
                {activeFlight && (
                  <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 inline-flex items-center gap-1">
                    <Plane className="w-3 h-3" /> {activeFlight.flightCode} ({formatDateEu(activeFlight.surveyDate)})
                  </span>
                )}
              </h2>
              <p className="text-xs text-gray-400">
                {quarry?.name || 'Explotación Activa'} · Carga automática de modelos del cliente
              </p>
            </div>
          </div>

          <div className="inline-flex bg-[#0b0f17] border border-gray-800 rounded-xl p-1 self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setViewerMode('3d')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer ${viewerMode === '3d'
                ? 'bg-blue-600 text-white shadow'
                : 'text-gray-400 hover:text-white'
                }`}
            >
              <Box className="w-3.5 h-3.5" />
              <span>Visor Fotogramétrico 3D</span>
            </button>
            <button
              type="button"
              onClick={() => setViewerMode('2d')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition cursor-pointer ${viewerMode === '2d'
                ? 'bg-cyan-600 text-white shadow'
                : 'text-gray-400 hover:text-white'
                }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              <span>Planos 2D &amp; Ortofoto</span>
            </button>
          </div>
        </div>

        {/* Source Selector & Upload Bar (Admin only) */}
        {isAdmin && (
          <div className="pt-3 border-t border-gray-800 flex flex-wrap items-center justify-between gap-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="inline-flex items-center gap-1.5 text-gray-300">
                <Box className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="font-semibold">Modelo 3D:</span>
                <select
                  value={selected3DKey}
                  onChange={(e) => setSelected3DKey(e.target.value)}
                  disabled={compatible3DDeliverables.length === 0 && !local3DPreview}
                  className="bg-[#0b0f17] border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white cursor-pointer max-w-[260px] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {compatible3DDeliverables.length === 0 && !local3DPreview ? (
                    <option value="">Sin modelo 3D subido</option>
                  ) : (
                    <>
                      {compatible3DDeliverables.map((d) => (
                        <option key={d.id} value={`deliv:${d.id}`}>
                          {d.title || d.fileName} ({d.fileName})
                        </option>
                      ))}
                      {local3DPreview && (
                        <option value="local">{local3DPreview.label}</option>
                      )}
                    </>
                  )}
                </select>
              </label>

              <label className="inline-flex items-center gap-1.5 text-gray-300">
                <ImageIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="font-semibold">Ortofoto:</span>
                <select
                  value={selectedOrthoKey}
                  onChange={(e) => setSelectedOrthoKey(e.target.value)}
                  disabled={compatibleOrthoDeliverables.length === 0 && !localOrthoFile}
                  className="bg-[#0b0f17] border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white cursor-pointer max-w-[240px] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {compatibleOrthoDeliverables.length === 0 && !localOrthoFile ? (
                    <option value="">Sin ortofoto subida</option>
                  ) : (
                    <>
                      {compatibleOrthoDeliverables.map((d) => (
                        <option key={d.id} value={`deliv:${d.id}`}>
                          {d.title || d.fileName} ({d.fileName})
                        </option>
                      ))}
                      {localOrthoFile && (
                        <option value="local">Local: {localOrthoFile.fileName}</option>
                      )}
                    </>
                  )}
                </select>
              </label>

              <label className="inline-flex items-center gap-1.5 text-gray-300">
                <Waves className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="font-semibold">Curvado DXF:</span>
                <select
                  value={selectedContourDxfKey}
                  onChange={(e) => setSelectedContourDxfKey(e.target.value)}
                  disabled={compatibleContourDxfDeliverables.length === 0 && !localContourDxfFile}
                  className="bg-[#0b0f17] border border-gray-700 rounded-lg px-2.5 py-1 text-xs text-white cursor-pointer max-w-[220px] disabled:opacity-60 disabled:cursor-not-allowed"
                  title="Un único DXF de curvado se proyecta automáticamente en el visor 3D y 2D"
                >
                  {compatibleContourDxfDeliverables.length === 0 && !localContourDxfFile ? (
                    <option value="">Sin DXF de curvado</option>
                  ) : (
                    <>
                      {compatibleContourDxfDeliverables.map((d) => (
                        <option key={d.id} value={`deliv:${d.id}`}>
                          {d.title || d.fileName} ({d.fileName})
                        </option>
                      ))}
                      {localContourDxfFile && (
                        <option value="local">Local: {localContourDxfFile.fileName}</option>
                      )}
                    </>
                  )}
                </select>
                {(compatibleContourDxfDeliverables.length > 0 || localContourDxfFile) && (
                  <button
                    type="button"
                    onClick={() => setShowDxfContours((v) => !v)}
                    className={`px-2 py-1 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 border transition cursor-pointer ${
                      showDxfContours
                        ? 'bg-amber-500/20 text-amber-200 border-amber-500/45'
                        : 'bg-[#0b0f17] text-gray-400 border-gray-700 hover:text-white'
                    }`}
                    title="Mostrar u ocultar curvas DXF sobre los visores 3D y 2D"
                  >
                    {showDxfContours ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                  </button>
                )}
              </label>

              {dxfOverlay ? (
                <button
                  type="button"
                  onClick={() => setShowDxfOverlay((v) => !v)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 border transition cursor-pointer ${
                    showDxfOverlay
                      ? 'bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 border-cyan-500/45'
                      : 'bg-[#0b0f17] hover:bg-gray-800 text-gray-400 hover:text-white border-gray-700'
                  }`}
                  title={`Superponer polígonos DXF 3D (${dxfOverlay.fileName}) sobre modelos 3D/2D`}
                  aria-pressed={showDxfOverlay}
                >
                  <FileCode2 className={`w-3.5 h-3.5 ${showDxfOverlay ? 'text-cyan-400' : 'text-gray-500'}`} />
                  <span>DXF 3D ({dxfOverlay.polygons.filter((p) => p.visible !== false).length})</span>
                  {showDxfOverlay ? (
                    <Eye className="w-3.5 h-3.5 text-cyan-300" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5 text-gray-500" />
                  )}
                </button>
              ) : (
                onOpenDxfSettings && (
                  <button
                    type="button"
                    onClick={onOpenDxfSettings}
                    className="px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 border border-dashed border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 transition cursor-pointer"
                    title="Ir a Configuración → Perímetros DXF 3D para subir el DXF de acopios de este vuelo"
                  >
                    <FileCode2 className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Asignar DXF 3D del vuelo</span>
                  </button>
                )
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label
                className="px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 font-semibold inline-flex items-center gap-1.5 cursor-pointer transition"
                title="Cargar temporalmente desde tu equipo (.OBJ, .GLB, .PLY, .STL, .LAS, .XYZ, .PCD, .PNG, .JPG, .TIF, .DXF)"
              >
                <FolderUp className="w-3.5 h-3.5 text-cyan-400" />
                <span>Abrir Archivo Local</span>
                <input
                  type="file"
                  accept=".glb,.gltf,.obj,.ply,.stl,.las,.laz,.xyz,.pcd,.csv,.txt,.pts,.png,.jpg,.jpeg,.webp,.tif,.tiff,.dxf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    e.target.value = '';
                    handleLocalPreviewFile(f);
                  }}
                />
              </label>

              {onOpenUploadModal && (
                <button
                  type="button"
                  onClick={onOpenUploadModal}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold inline-flex items-center gap-1.5 shadow cursor-pointer transition"
                  title="Subir archivo 3D, ortofoto o DXF de curvado al servidor del cliente (storage/<Cliente>/<Vuelo>/)"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Subir Modelo / DXF al Cliente</span>
                </button>
              )}
            </div>
          </div>
        )}

        {localSuccessNotice && (
          <div className="bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              {localSuccessNotice}
            </span>
            <button
              type="button"
              onClick={() => setLocalSuccessNotice(null)}
              className="text-emerald-300 hover:text-white text-[11px] font-semibold cursor-pointer"
            >
              Cerrar
            </button>
          </div>
        )}

        {localHintError && (
          <div className="bg-amber-500/10 border border-amber-500/40 text-amber-200 rounded-xl px-3 py-2 text-xs">
            {localHintError}
          </div>
        )}
      </div>

      {/* Active Viewer (strictly single quarry uploaded models) */}
      {viewerMode === '3d' ? (
        hasAny3DSource ? (
          <Quarry3DViewer
            key={quarry?.id ?? 'single-quarry'}
            quarry={quarry}
            activeFlight={activeFlight}
            terrain={terrain}
            external3DSource={activeExternal3DSource}
            customOrthoCanvas={loadedOrthophoto?.canvas ?? null}
            onModelBoundsChange={setLoaded3DCadTransform}
            dxfOverlay={dxfOverlay}
            dxfStockpiles={scopedStockpiles}
            showDxfOverlay={showDxfOverlay}
            onToggleDxfOverlay={() => setShowDxfOverlay((v) => !v)}
            dxfOpacity={dxfOpacity}
            onChangeDxfOpacity={setDxfOpacity}
            contourDxf={loadedContourDxf}
            contourDxfLoading={contourDxfLoading}
            contourDxfProgress={contourDxfProgress}
            contourDxfFileName={activeContourDxfTarget?.fileName ?? null}
            showDxfContours={showDxfContours}
            onToggleDxfContours={() => setShowDxfContours((v) => !v)}
            contourDxfError={contourDxfError}
          />
        ) : (
          <div className="glass-panel border border-gray-800 rounded-2xl flex-1 min-h-[540px] flex items-center justify-center p-6 bg-[#090d16]">
            <div className="max-w-md w-full text-center space-y-4 bg-[#0f1623] border border-gray-800 rounded-2xl p-6 sm:p-8 shadow-xl">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-center justify-center">
                <Box className="w-7 h-7" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base sm:text-lg font-bold text-white">
                  No hay archivo 3D para visualizar
                </h3>
                <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
                  {isAdmin
                    ? 'No hay ningún modelo 3D ni DXF de curvado subido para este cliente o vuelo. Sube un archivo (.OBJ, .GLB, .PLY, .STL, .LAS, .XYZ, .PCD o .DXF) para que el cliente pueda visualizarlo.'
                    : 'No hay ningún archivo de modelo 3D disponible para visualizar en este momento. Por favor, ponte en contacto con el administrador para que suba los archivos del modelo.'}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2">
                {compatibleOrthoDeliverables.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setViewerMode('2d')}
                    className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow cursor-pointer transition"
                  >
                    <MapIcon className="w-3.5 h-3.5" />
                    <span>Ver Ortofoto en Planos 2D</span>
                  </button>
                )}
                {isAdmin && onOpenUploadModal && (
                  <button
                    type="button"
                    onClick={onOpenUploadModal}
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow cursor-pointer transition"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>Subir Modelo 3D / DXF al Cliente</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      ) : !hasAnyOrthoSource ? (
        <div className="glass-panel border border-gray-800 rounded-2xl flex-1 min-h-[540px] flex items-center justify-center p-6 bg-[#090d16]">
          <div className="max-w-md w-full text-center space-y-4 bg-[#0f1623] border border-gray-800 rounded-2xl p-6 sm:p-8 shadow-xl">
            <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex items-center justify-center">
              <ImageIcon className="w-7 h-7" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base sm:text-lg font-bold text-white">
                No hay ortofoto ni plano 2D para visualizar
              </h3>
              <p className="text-xs sm:text-sm text-gray-300 leading-relaxed">
                {isAdmin
                  ? 'No hay ninguna ortofoto, plano 2D ni DXF de curvado subido para este cliente o vuelo. Sube una imagen (.TIF, .PNG, .JPG, .WEBP) o un .DXF para que el cliente pueda visualizarlo.'
                  : 'No hay ningún archivo de ortofoto o plano 2D disponible para visualizar en este momento. Por favor, ponte en contacto con el administrador para que suba los archivos del vuelo.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-2">
              {compatible3DDeliverables.length > 0 && (
                <button
                  type="button"
                  onClick={() => setViewerMode('3d')}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow cursor-pointer transition"
                >
                  <Box className="w-3.5 h-3.5" />
                  <span>Ver Modelo en Visor 3D</span>
                </button>
              )}
              {isAdmin && onOpenUploadModal && (
                <button
                  type="button"
                  onClick={onOpenUploadModal}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 shadow cursor-pointer transition"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Subir Ortofoto / DXF al Cliente</span>
                </button>
              )}
            </div>
          </div>
        </div>
      ) : activeOrthoTarget && orthoLoading ? (
        <div className="glass-panel border border-gray-800 rounded-2xl flex-1 min-h-[540px] flex items-center justify-center p-6 bg-[#090d16]">
          <div className="text-center space-y-3 p-6 rounded-2xl border border-cyan-500/35 bg-[#0f1623] max-w-sm shadow-xl">
            <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto" />
            <p className="text-sm font-bold text-cyan-300">Cargando ortofoto del cliente...</p>
            <p className="text-xs text-gray-400 break-all">{activeOrthoTarget?.fileName}</p>
          </div>
        </div>
      ) : activeOrthoTarget && (orthoError || !loadedOrthophoto) ? (
        <div className="glass-panel border border-gray-800 rounded-2xl flex-1 min-h-[540px] flex items-center justify-center p-6 bg-[#090d16]">
          <div className="max-w-md w-full text-center space-y-4 bg-[#0f1623] border border-red-500/40 rounded-2xl p-6 shadow-xl">
            <div className="w-12 h-12 mx-auto rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 flex items-center justify-center">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-base font-bold text-red-300">No se pudo cargar la ortofoto</h3>
              <p className="text-xs text-gray-300 leading-relaxed">
                {orthoError || 'El archivo de ortofoto no se pudo procesar. Ponte en contacto con el administrador.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOrthoReloadTick((t) => t + 1)}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Reintentar carga</span>
            </button>
          </div>
        </div>
      ) : !activeOrthoTarget && contourDxfLoading ? (
        <div className="glass-panel border border-gray-800 rounded-2xl flex-1 min-h-[540px] flex items-center justify-center p-6 bg-[#090d16]">
          <div className="text-center space-y-3 p-6 rounded-2xl border border-amber-500/35 bg-[#0f1623] max-w-sm shadow-xl">
            <Loader2 className="w-8 h-8 text-amber-400 animate-spin mx-auto" />
            <p className="text-sm font-bold text-amber-300">Cargando curvado DXF del cliente...</p>
            <p className="text-xs text-gray-400 break-all">{activeContourDxfTarget?.fileName}</p>
          </div>
        </div>
      ) : (
        <Quarry2DOrthophotoViewer
          key={quarry?.id ?? 'single-quarry'}
          quarry={quarry}
          activeFlight={activeFlight}
          terrain={terrain}
          customOrthoCanvas={loadedOrthophoto?.canvas ?? null}
          orthoNaturalSize={
            loadedOrthophoto
              ? {
                  width: loadedOrthophoto.naturalWidth,
                  height: loadedOrthophoto.naturalHeight,
                }
              : null
          }
          planBounds={resolved2DPlanBounds}
          dxfOverlay={dxfOverlay}
          dxfStockpiles={scopedStockpiles}
          showDxfOverlay={showDxfOverlay}
          onToggleDxfOverlay={() => setShowDxfOverlay((v) => !v)}
          dxfOpacity={dxfOpacity}
          onChangeDxfOpacity={setDxfOpacity}
          contourDxf={loadedContourDxf}
          showDxfContours={showDxfContours}
          onToggleDxfContours={() => setShowDxfContours((v) => !v)}
          contourDxfError={contourDxfError}
        />
      )}
    </section>
  );
};
