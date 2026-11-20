import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Building2,
  Plane,
  Package,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { Client, Quarry, Zone, Survey, Stockpile } from '../types.ts';
import {
  Parsed3DsurveyPdfResult,
  ParsedPdfStockpileItem,
  groupPdfTextItemsIntoLines,
  parse3DsurveyMeasurementsLines,
} from '../utils/pdfMeasurementsParser.ts';
import {
  MATERIALS_UPDATED_EVENT,
  MaterialDensityEntry,
  formatMaterialDisplayName,
  getMaterialDensityCatalog,
} from '../utils/materialDensities.ts';
import { localDataStore } from '../utils/localDataStore.ts';
import { formatDateEu } from '../utils/dateUtils.ts';
import { formatEsNumber } from '../utils/numberFormat.ts';

interface PdfMeasurementsImportModalProps {
  open: boolean;
  clients: Client[];
  quarries: Quarry[];
  zones: Zone[];
  surveys: Survey[];
  stockpiles: Stockpile[];
  defaultClientId?: number;
  defaultSurveyId?: number;
  onClose: () => void;
  onSuccess: (title: string, message: string) => Promise<void> | void;
}

interface EditablePdfRow {
  selected: boolean;
  index: number;
  code: string;
  name: string;
  stockpileType: Stockpile['stockpileType'];
  material: string;
  densityTonM3: number;
  fillVolumeM3: number;
  cutVolumeM3: number;
  netVolumeM3: number;
  area2dM2: number;
  baseElevationM?: number;
  existingStockpile: Stockpile | null;
}

function normalizeMatch(raw?: string): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

async function parsePdfInBrowser(
  file: File
): Promise<Parsed3DsurveyPdfResult & { pageCount: number }> {
  const [pdfjsLib, workerUrlMod] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrlMod.default;

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
  });
  const doc = await loadingTask.promise;

  const allLines: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    allLines.push(...groupPdfTextItemsIntoLines(textContent.items));
  }

  const parsed = parse3DsurveyMeasurementsLines(allLines, file.name);
  return {
    ...parsed,
    pageCount: doc.numPages,
  };
}

export const PdfMeasurementsImportModal: React.FC<PdfMeasurementsImportModalProps> = ({
  open,
  clients,
  quarries,
  zones,
  surveys,
  stockpiles,
  defaultClientId,
  defaultSurveyId,
  onClose,
  onSuccess,
}) => {
  const [catalog, setCatalog] = useState<MaterialDensityEntry[]>(() => getMaterialDensityCatalog());
  const [selectedClientId, setSelectedClientId] = useState<number>(defaultClientId || clients[0]?.id || 0);
  const [selectedSurveyId, setSelectedSurveyId] = useState<number>(defaultSurveyId || 0);
  const [defaultMaterialId, setDefaultMaterialId] = useState<string>('');
  const [defaultType, setDefaultType] = useState<Stockpile['stockpileType']>('stockpile');

  const [pdfFileName, setPdfFileName] = useState<string>('');
  const [pdfSoftware, setPdfSoftware] = useState<string>('');
  const [pdfPageCount, setPdfPageCount] = useState<number>(0);
  const [pdfDateHint, setPdfDateHint] = useState<string>('');
  const [isParsing, setIsParsing] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [rows, setRows] = useState<EditablePdfRow[]>([]);
  const [isImporting, setIsImporting] = useState<boolean>(false);

  const wasOpenRef = useRef<boolean>(false);

  useEffect(() => {
    const sync = () => setCatalog(getMaterialDensityCatalog());
    window.addEventListener(MATERIALS_UPDATED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(MATERIALS_UPDATED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    if (!defaultMaterialId && catalog.length > 0) {
      setDefaultMaterialId(catalog[0].id);
    }
  }, [catalog, defaultMaterialId]);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;

    const firstClientWithSurveys = clients.find((c) => {
      const qIds = new Set(quarries.filter((q) => q.clientId === c.id).map((q) => q.id));
      const zIds = new Set(zones.filter((z) => qIds.has(z.quarryId)).map((z) => z.id));
      return surveys.some((s) => zIds.has(s.zoneId));
    });

    const initialClient = defaultClientId || firstClientWithSurveys?.id || clients[0]?.id || 0;
    setSelectedClientId(initialClient);
    setSelectedSurveyId(defaultSurveyId || 0);
    setPdfFileName('');
    setPdfSoftware('');
    setPdfPageCount(0);
    setPdfDateHint('');
    setIsParsing(false);
    setIsDragging(false);
    setErrorMsg('');
    setRows([]);
    setIsImporting(false);
  }, [open, defaultClientId, defaultSurveyId, clients, quarries, zones, surveys]);

  const scopedSurveys = useMemo(() => {
    const qIds = new Set(
      quarries.filter((q) => !selectedClientId || q.clientId === selectedClientId).map((q) => q.id)
    );
    const zIds = new Set(zones.filter((z) => qIds.has(z.quarryId)).map((z) => z.id));
    return surveys.filter((s) => zIds.has(s.zoneId));
  }, [selectedClientId, quarries, zones, surveys]);

  useEffect(() => {
    if (scopedSurveys.length > 0) {
      if (!selectedSurveyId || !scopedSurveys.some((s) => s.id === selectedSurveyId)) {
        setSelectedSurveyId(scopedSurveys[0].id);
      }
    } else {
      setSelectedSurveyId(0);
    }
  }, [scopedSurveys, selectedSurveyId]);

  const defaultMaterialEntry = useMemo(() => {
    return catalog.find((m) => m.id === defaultMaterialId) || catalog[0];
  }, [catalog, defaultMaterialId]);

  // Re-evaluate existing stockpile matches whenever target surveyId changes
  useEffect(() => {
    if (rows.length === 0 || !selectedSurveyId) return;
    const flightStockpiles = stockpiles.filter((st) => st.surveyId === selectedSurveyId);
    setRows((prev) =>
      prev.map((r) => {
        const matched =
          flightStockpiles.find(
            (st) =>
              normalizeMatch(st.code) === normalizeMatch(r.code) ||
              normalizeMatch(st.name) === normalizeMatch(r.name)
          ) || null;
        return {
          ...r,
          existingStockpile: matched,
          code: matched ? matched.code : r.code,
          material: matched ? matched.material : r.material,
          densityTonM3: matched ? matched.densityTonM3 : r.densityTonM3,
          stockpileType: matched ? matched.stockpileType : r.stockpileType,
        };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSurveyId]);

  const summary = useMemo(() => {
    const active = rows.filter((r) => r.selected);
    let createCount = 0;
    let updateCount = 0;
    let fill = 0;
    let cut = 0;
    let net = 0;
    let area2d = 0;
    let tonnage = 0;

    for (const r of active) {
      if (r.existingStockpile) updateCount++;
      else createCount++;
      fill += r.fillVolumeM3;
      cut += r.cutVolumeM3;
      net += r.netVolumeM3;
      area2d += r.area2dM2;
      tonnage += Math.abs(r.netVolumeM3) * r.densityTonM3;
    }

    return {
      totalParsed: rows.length,
      selectedCount: active.length,
      createCount,
      updateCount,
      fill,
      cut,
      net,
      area2d,
      tonnage,
    };
  }, [rows]);

  if (!open) return null;

  const handleUploadPdf = async (file: File | undefined) => {
    if (!file) return;
    setErrorMsg('');
    setPdfFileName(file.name);

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setErrorMsg('El archivo debe tener extensión .pdf.');
      setRows([]);
      return;
    }

    setIsParsing(true);
    try {
      let parsedPayload: {
        pageCount: number;
        software?: string;
        fileNameDateHint?: string;
        items: ParsedPdfStockpileItem[];
      } | null = null;

      // 1. Try server-side extraction first when authenticated
      const token = typeof window !== 'undefined' ? localStorage.getItem('ingeodron_token') : null;
      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/stockpiles/parse-pdf', {
          method: 'POST',
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: formData,
        });
        if (res.ok) {
          const payload = (await res.json().catch(() => null)) as {
            ok?: boolean;
            pageCount?: number;
            software?: string;
            fileNameDateHint?: string;
            items?: ParsedPdfStockpileItem[];
          } | null;
          if (payload?.ok && Array.isArray(payload.items) && payload.items.length > 0) {
            parsedPayload = {
              pageCount: payload.pageCount || 1,
              software: payload.software,
              fileNameDateHint: payload.fileNameDateHint,
              items: payload.items,
            };
          }
        }
      } catch {
        // Fallback to in-browser PDF extraction below
      }

      // 2. Fallback: extract directly in browser with pdfjs-dist
      if (!parsedPayload) {
        const browserParsed = await parsePdfInBrowser(file);
        if (browserParsed.items.length === 0) {
          throw new Error(
            'No se detectaron bloques de volumen de acopios en el PDF (formato esperado: informe de mediciones 3Dsurvey con Nombre, Relleno, Desmonte, Neto y Área 2D).'
          );
        }
        parsedPayload = {
          pageCount: browserParsed.pageCount,
          software: browserParsed.software,
          fileNameDateHint: browserParsed.fileNameDateHint,
          items: browserParsed.items,
        };
      }

      setPdfSoftware(parsedPayload.software || '3Dsurvey');
      setPdfPageCount(parsedPayload.pageCount || 1);
      setPdfDateHint(parsedPayload.fileNameDateHint || '');

      const flightStockpiles = selectedSurveyId
        ? stockpiles.filter((st) => st.surveyId === selectedSurveyId)
        : [];
      const fallbackMatName = defaultMaterialEntry
        ? formatMaterialDisplayName(defaultMaterialEntry)
        : 'Grava 20/40';
      const fallbackDensity = defaultMaterialEntry?.defaultDensity ?? 1.68;

      const nextRows: EditablePdfRow[] = parsedPayload.items.map((item) => {
        const matched =
          flightStockpiles.find(
            (st) =>
              normalizeMatch(st.code) === normalizeMatch(item.suggestedCode) ||
              normalizeMatch(st.name) === normalizeMatch(item.name)
          ) || null;

        return {
          selected: true,
          index: item.index,
          code: matched ? matched.code : item.suggestedCode,
          name: item.name,
          stockpileType: matched ? matched.stockpileType : defaultType,
          material: matched ? matched.material : fallbackMatName,
          densityTonM3: matched ? matched.densityTonM3 : fallbackDensity,
          fillVolumeM3: item.fillVolumeM3,
          cutVolumeM3: item.cutVolumeM3,
          netVolumeM3: item.netVolumeM3,
          area2dM2: item.area2dM2,
          baseElevationM: item.baseElevationM,
          existingStockpile: matched,
        };
      });

      setRows(nextRows);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Error analizando el archivo PDF.');
      setRows([]);
    } finally {
      setIsParsing(false);
    }
  };

  const handleApplyDefaultMaterialAll = () => {
    if (!defaultMaterialEntry) return;
    const matLabel = formatMaterialDisplayName(defaultMaterialEntry);
    const dens = defaultMaterialEntry.defaultDensity;
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        material: matLabel,
        densityTonM3: dens,
        stockpileType: defaultType,
      }))
    );
  };

  const handleRowMaterialChange = (idx: number, entryId: string) => {
    const found = catalog.find((m) => m.id === entryId);
    if (!found) return;
    setRows((prev) =>
      prev.map((r, i) =>
        i === idx
          ? {
              ...r,
              material: formatMaterialDisplayName(found),
              densityTonM3: found.defaultDensity,
            }
          : r
      )
    );
  };

  const handleConfirmImport = async () => {
    if (!selectedSurveyId) {
      setErrorMsg('Selecciona un vuelo destino válido antes de importar los acopios.');
      return;
    }
    if (summary.selectedCount === 0) {
      setErrorMsg('Selecciona al menos un acopio para importar.');
      return;
    }
    setErrorMsg('');
    setIsImporting(true);
    try {
      let created = 0;
      let updated = 0;

      for (const r of rows) {
        if (!r.selected) continue;

        const payload = {
          surveyId: selectedSurveyId,
          code: r.code.trim() || `ACO-${r.index}`,
          name: r.name.trim() || `Acopio ${r.index}`,
          stockpileType: r.stockpileType,
          material: r.material.trim() || 'Grava 20/40',
          densityTonM3: Math.max(0.1, Number(r.densityTonM3) || 1.68),
          baseElevationM: Number(r.baseElevationM ?? r.existingStockpile?.baseElevationM ?? 115),
          areaM2: Math.round(Number(r.area2dM2 || 0)),
          fillVolumeM3: Number(r.fillVolumeM3 || 0),
          cutVolumeM3: Number(r.cutVolumeM3 || 0),
        };

        if (r.existingStockpile) {
          localDataStore.updateStockpile(r.existingStockpile.id, payload);
          updated++;
        } else {
          localDataStore.createStockpile(payload);
          created++;
        }
      }

      const targetFlight = surveys.find((s) => s.id === selectedSurveyId);
      await onSuccess(
        'Importación de Acopios Completada',
        `Vuelo ${targetFlight?.flightCode || ''}: ${created} acopio(s) creados y ${updated} actualizado(s).`
      );
      onClose();
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'No se pudieron guardar los acopios importados en el vuelo.'
      );
    } finally {
      setIsImporting(false);
    }
  };

  const allSelected = rows.length > 0 && rows.every((r) => r.selected);

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-import-modal-title"
    >
      <div className="bg-[#111827] border border-gray-800 rounded-2xl w-full max-w-6xl max-h-[92vh] shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-[#0f172a]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
              <FileText className="w-4 h-4" />
            </div>
            <div>
              <h3 id="pdf-import-modal-title" className="text-sm font-bold text-white">
                Importar Datos de Acopios desde PDF (3Dsurvey)
              </h3>
              <p className="text-[11px] text-gray-400">
                Importa únicamente los campos de la tabla de acopios: código, nombre, relleno, desmonte, neto, superficie 2D y cota base.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1.5 rounded-lg hover:bg-gray-800 transition cursor-pointer"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs flex-1">
          {/* Step 1: Target Client / Flight + Default Material */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-[#0b0f17] border border-gray-800 rounded-xl p-3.5">
            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1 flex items-center gap-1">
                <Building2 className="w-3.5 h-3.5 text-cyan-400" /> Cliente
              </label>
              <select
                value={selectedClientId}
                onChange={(e) => setSelectedClientId(Number(e.target.value))}
                className="w-full bg-[#111827] border border-gray-700 rounded-lg px-2.5 py-2 text-white text-xs cursor-pointer"
              >
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1 flex items-center gap-1">
                <Plane className="w-3.5 h-3.5 text-sky-400" /> Vuelo Destino
              </label>
              <select
                value={selectedSurveyId}
                onChange={(e) => setSelectedSurveyId(Number(e.target.value))}
                className="w-full bg-[#111827] border border-gray-700 rounded-lg px-2.5 py-2 text-white text-xs cursor-pointer"
              >
                {scopedSurveys.length === 0 ? (
                  <option value={0}>Sin vuelos disponibles para este cliente</option>
                ) : (
                  scopedSurveys.map((s) => {
                    const zone = zones.find((z) => z.id === s.zoneId);
                    return (
                      <option key={s.id} value={s.id}>
                        {s.flightCode} ({formatDateEu(s.surveyDate)}){zone ? ` • ${zone.name}` : ''}
                      </option>
                    );
                  })
                )}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1 flex items-center gap-1">
                <Package className="w-3.5 h-3.5 text-amber-400" /> Material por Defecto
              </label>
              <div className="flex items-center gap-1.5">
                <select
                  value={defaultMaterialId}
                  onChange={(e) => setDefaultMaterialId(e.target.value)}
                  className="flex-1 min-w-0 bg-[#111827] border border-gray-700 rounded-lg px-2 py-2 text-white text-xs cursor-pointer"
                >
                  {catalog.map((m) => (
                    <option key={m.id} value={m.id}>
                      {formatMaterialDisplayName(m)} ({m.defaultDensity.toFixed(2)} t/m³)
                    </option>
                  ))}
                </select>
                {rows.length > 0 && (
                  <button
                    type="button"
                    onClick={handleApplyDefaultMaterialAll}
                    className="px-2 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 rounded-lg text-[10px] font-bold shrink-0 cursor-pointer"
                    title="Aplicar este material, densidad y tipo a todas las filas detectadas"
                  >
                    Aplicar
                  </button>
                )}
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-gray-300 mb-1">
                Tipo de Elemento
              </label>
              <select
                value={defaultType}
                onChange={(e) => setDefaultType(e.target.value as Stockpile['stockpileType'])}
                className="w-full bg-[#111827] border border-gray-700 rounded-lg px-2.5 py-2 text-white text-xs cursor-pointer"
              >
                <option value="stockpile">Acopio</option>
                <option value="bench_extraction">Frente de Extracción</option>
                <option value="fill_dump">Vertedero / Relleno</option>
                <option value="basin">Balsa</option>
              </select>
            </div>
          </div>

          {!selectedSurveyId && (
            <div className="p-3 rounded-xl bg-amber-950/50 border border-amber-700/60 text-amber-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Este cliente no tiene vuelos registrados todavía. Crea primero un vuelo en la pestaña <strong>Vuelos</strong> para poder asociarle los acopios.
              </span>
            </div>
          )}

          {/* Step 2: PDF Upload Dropzone */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              handleUploadPdf(e.dataTransfer.files?.[0]);
            }}
            className={`flex flex-col sm:flex-row items-center justify-between gap-3 border-2 border-dashed rounded-xl p-4 cursor-pointer transition ${
              isDragging
                ? 'border-emerald-400 bg-emerald-950/30'
                : 'border-gray-700 hover:border-emerald-500/60 bg-[#0b0f17]/70'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                {isParsing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              </div>
              <div>
                <div className="font-bold text-white">
                  {isParsing
                    ? 'Extrayendo datos del PDF...'
                    : pdfFileName
                      ? pdfFileName
                      : 'Seleccionar o arrastrar informe PDF de mediciones (3Dsurvey)'}
                </div>
                <div className="text-[11px] text-gray-400">
                  {pdfSoftware
                    ? `${pdfSoftware} • ${pdfPageCount} página(s)${pdfDateHint ? ` • Fecha archivo: ${formatDateEu(pdfDateHint)}` : ''}`
                    : 'Extrae únicamente Nombre, Relleno, Desmonte, Neto, Superficie 2D y Cota base para nuestra tabla.'}
                </div>
              </div>
            </div>
            <span className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shrink-0">
              {pdfFileName ? 'Cambiar PDF' : 'Examinar PDF'}
            </span>
            <input
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                handleUploadPdf(e.target.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
          </label>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-950/60 border border-red-800 text-red-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Step 3: Preview Totals & Editable Table (strictly matching portal table columns) */}
          {rows.length > 0 && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                <div className="bg-[#0b0f17] border border-gray-800 rounded-xl p-2.5">
                  <div className="text-[10px] uppercase text-gray-400 font-semibold">Seleccionados</div>
                  <div className="text-base font-bold text-white mt-0.5">
                    {summary.selectedCount}{' '}
                    <span className="text-[11px] font-normal text-gray-400">/ {summary.totalParsed}</span>
                  </div>
                  <div className="text-[10px] text-emerald-400">
                    {summary.createCount} nuevos · {summary.updateCount} actualizar
                  </div>
                </div>
                <div className="bg-[#0b0f17] border border-gray-800 rounded-xl p-2.5">
                  <div className="text-[10px] uppercase text-gray-400 font-semibold">Relleno Total</div>
                  <div className="text-base font-bold text-emerald-400 font-mono mt-0.5">
                    {formatEsNumber(summary.fill, 2)} m³
                  </div>
                </div>
                <div className="bg-[#0b0f17] border border-gray-800 rounded-xl p-2.5">
                  <div className="text-[10px] uppercase text-gray-400 font-semibold">Desmonte Total</div>
                  <div className="text-base font-bold text-rose-400 font-mono mt-0.5">
                    {formatEsNumber(summary.cut, 2)} m³
                  </div>
                </div>
                <div className="bg-[#0b0f17] border border-gray-800 rounded-xl p-2.5">
                  <div className="text-[10px] uppercase text-gray-400 font-semibold">Volumen Neto</div>
                  <div className="text-base font-bold text-cyan-300 font-mono mt-0.5">
                    {formatEsNumber(summary.net, 2)} m³
                  </div>
                </div>
                <div className="bg-[#0b0f17] border border-gray-800 rounded-xl p-2.5">
                  <div className="text-[10px] uppercase text-gray-400 font-semibold">Superficie 2D</div>
                  <div className="text-base font-bold text-indigo-300 font-mono mt-0.5">
                    {formatEsNumber(summary.area2d, 2)} m²
                  </div>
                </div>
                <div className="bg-[#0b0f17] border border-gray-800 rounded-xl p-2.5">
                  <div className="text-[10px] uppercase text-gray-400 font-semibold">Tonelaje Est.</div>
                  <div className="text-base font-bold text-amber-300 font-mono mt-0.5">
                    {formatEsNumber(summary.tonnage, 1)} t
                  </div>
                </div>
              </div>

              <div className="border border-gray-800 rounded-xl overflow-hidden bg-[#0b0f17]">
                <div className="max-h-[40vh] overflow-auto">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-[#0f172a] text-[10px] uppercase text-gray-400 border-b border-gray-800 z-10">
                      <tr>
                        <th className="p-2 text-center w-8">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={(e) =>
                              setRows((prev) => prev.map((r) => ({ ...r, selected: e.target.checked })))
                            }
                            className="cursor-pointer"
                            title="Seleccionar / deseleccionar todos"
                          />
                        </th>
                        <th className="p-2">Acción</th>
                        <th className="p-2">Código</th>
                        <th className="p-2">Acopio</th>
                        <th className="p-2">Material</th>
                        <th className="p-2 text-right">Densidad</th>
                        <th className="p-2 text-right">Relleno (m³)</th>
                        <th className="p-2 text-right">Desmonte (m³)</th>
                        <th className="p-2 text-right">Neto (m³)</th>
                        <th className="p-2 text-right">Superficie (m²)</th>
                        <th className="p-2 text-right">Cota Base (m)</th>
                        <th className="p-2 text-right">Tonelaje (t)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800/70 text-[11px]">
                      {rows.map((row, idx) => {
                        const matchedCat = catalog.find(
                          (m) =>
                            formatMaterialDisplayName(m).toLowerCase() === row.material.toLowerCase() ||
                            m.name.toLowerCase() === row.material.toLowerCase()
                        );
                        const rowTonnage = Math.abs(row.netVolumeM3) * row.densityTonM3;
                        return (
                          <tr
                            key={row.index}
                            className={`transition ${
                              row.selected ? 'hover:bg-slate-800/40' : 'opacity-45 bg-slate-950/60'
                            }`}
                          >
                            <td className="p-2 text-center">
                              <input
                                type="checkbox"
                                checked={row.selected}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((it, i) => (i === idx ? { ...it, selected: e.target.checked } : it))
                                  )
                                }
                                className="cursor-pointer"
                              />
                            </td>
                            <td className="p-2 whitespace-nowrap">
                              {row.existingStockpile ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
                                  Actualizar
                                </span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                                  Crear
                                </span>
                              )}
                            </td>
                            <td className="p-1.5">
                              <input
                                type="text"
                                value={row.code}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((it, i) => (i === idx ? { ...it, code: e.target.value } : it))
                                  )
                                }
                                className="w-20 bg-[#111827] border border-gray-700 rounded px-1.5 py-1 text-cyan-300 font-mono text-[11px]"
                              />
                            </td>
                            <td className="p-1.5">
                              <input
                                type="text"
                                value={row.name}
                                onChange={(e) =>
                                  setRows((prev) =>
                                    prev.map((it, i) => (i === idx ? { ...it, name: e.target.value } : it))
                                  )
                                }
                                className="w-28 bg-[#111827] border border-gray-700 rounded px-1.5 py-1 text-white font-semibold text-[11px]"
                              />
                            </td>
                            <td className="p-1.5">
                              <select
                                value={matchedCat?.id || '__custom__'}
                                onChange={(e) => handleRowMaterialChange(idx, e.target.value)}
                                className="w-40 bg-[#111827] border border-gray-700 rounded px-1.5 py-1 text-white text-[11px] cursor-pointer"
                              >
                                {!matchedCat && <option value="__custom__">{row.material}</option>}
                                {catalog.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {formatMaterialDisplayName(m)}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="p-1.5 text-right">
                              <input
                                type="number"
                                step="0.01"
                                min="0.1"
                                value={row.densityTonM3}
                                onChange={(e) => {
                                  const next = parseFloat(e.target.value) || 0.1;
                                  setRows((prev) =>
                                    prev.map((it, i) => (i === idx ? { ...it, densityTonM3: next } : it))
                                  );
                                }}
                                className="w-16 text-right bg-[#111827] border border-gray-700 rounded px-1.5 py-1 text-amber-300 font-mono text-[11px]"
                              />
                            </td>
                            <td className="p-2 text-right font-mono text-emerald-400 whitespace-nowrap">
                              {formatEsNumber(row.fillVolumeM3, 2)}
                            </td>
                            <td className="p-2 text-right font-mono text-rose-400 whitespace-nowrap">
                              {formatEsNumber(row.cutVolumeM3, 2)}
                            </td>
                            <td className="p-2 text-right font-mono font-bold text-white whitespace-nowrap">
                              {formatEsNumber(row.netVolumeM3, 2)}
                            </td>
                            <td className="p-2 text-right font-mono text-indigo-300 whitespace-nowrap">
                              {formatEsNumber(row.area2dM2, 2)}
                            </td>
                            <td className="p-2 text-right font-mono text-gray-300 whitespace-nowrap">
                              {row.baseElevationM !== undefined ? formatEsNumber(row.baseElevationM, 2) : '—'}
                            </td>
                            <td className="p-2 text-right font-mono font-semibold text-amber-300 whitespace-nowrap">
                              {formatEsNumber(rowTonnage, 1)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 bg-[#0f172a] flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-gray-400 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>
              Si un acopio ya existe en el vuelo (por código o nombre), se actualizarán solo sus mediciones conservando material, observaciones y fotos.
            </span>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-xs font-semibold cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={!selectedSurveyId || summary.selectedCount === 0 || isImporting || isParsing}
              onClick={handleConfirmImport}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold rounded-lg shadow text-xs inline-flex items-center gap-1.5 cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              {isImporting
                ? 'Importando...'
                : `Importar ${summary.selectedCount} Acopio${summary.selectedCount === 1 ? '' : 's'} al Vuelo`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
