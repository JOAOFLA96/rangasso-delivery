import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { storage } from '../../lib/api';

// Etiqueta de validade 50 x 30 mm e impressão pelo navegador.
// Cada etiqueta vira uma página do tamanho exato da etiqueta (@page), assim qualquer impressora
// térmica de etiqueta com driver no Windows (Elgin, Argox, Zebra, Bematech, Tomate...) imprime certo.

export type Storage = 'chilled' | 'frozen' | 'ambient';
export type LabelType = 'handled' | 'opened' | 'thawing' | 'sample';

export const STORAGE_LABELS: Record<Storage, string> = { chilled: 'Resfriado', frozen: 'Congelado', ambient: 'Ambiente' };
export const STORAGE_PRINT: Record<Storage, string> = { chilled: 'RESFRIADO ≤5°C', frozen: 'CONGELADO ≤-18°C', ambient: 'AMBIENTE' };
export const TYPE_LABELS: Record<LabelType, string> = { handled: 'Manipulado', opened: 'Produto aberto', thawing: 'Descongelando', sample: 'Amostra' };
const TYPE_PRINT: Record<LabelType, string> = { handled: 'MANIPULADO', opened: 'ABERTO', thawing: 'DESCONGELANDO', sample: 'AMOSTRA' };

export interface LabelData {
  productName: string;
  labelType: LabelType;
  storage: Storage;
  handledAt: string;
  expiresAt: string;
  responsible: string;
  lot: string;
  quantityText: string;
  extra: string;
  notes?: string;
}

const WEEKDAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
const pad = (n: number) => String(n).padStart(2, '0');
export function labelDate(iso: string, weekday = false) {
  const d = new Date(iso);
  const s = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return weekday ? `${WEEKDAYS[d.getDay()]} ${s}` : s;
}

// Valor para <input type="datetime-local"> no horário do computador.
export function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatShelfLife(hours: number | null) {
  if (hours == null) return '—';
  if (hours % 24 === 0) return `${hours / 24} ${hours === 24 ? 'dia' : 'dias'}`;
  return `${hours} h`;
}

export function LabelFace({ data, storeName }: { data: LabelData; storeName: string }) {
  const footer = [data.quantityText, data.extra, data.notes].filter(Boolean).join(' · ');
  return (
    <div className="lbl-face">
      <div className="lbl-name">{data.productName || 'PRODUTO'}</div>
      <div className="lbl-band">{TYPE_PRINT[data.labelType]} · {STORAGE_PRINT[data.storage]}</div>
      <div className="lbl-line"><span>MANIP.</span> {data.handledAt ? labelDate(data.handledAt) : '—'}</div>
      <div className="lbl-line lbl-exp"><span>VAL.</span> {data.expiresAt ? labelDate(data.expiresAt, true) : '—'}</div>
      <div className="lbl-line lbl-two"><span><span>RESP.</span> {data.responsible}</span><span><span>LOTE</span> {data.lot}</span></div>
      <div className="lbl-foot">{footer ? `${footer} — ` : ''}{storeName}</div>
    </div>
  );
}

function CalibrationFace({ n, total }: { n: number; total: number }) {
  return (
    <div className="lbl-face lbl-calib">
      <div className="lbl-name">TESTE {n}/{total} · 50 x 30 mm</div>
      <div className="lbl-line">A moldura deve ficar inteira e na</div>
      <div className="lbl-line">mesma posição em todas as etiquetas.</div>
      <div className="lbl-line">Se descer a cada uma: avanço maior.</div>
      <div className="lbl-line">Se subir a cada uma: avanço menor.</div>
    </div>
  );
}

// Ajustes de impressão por computador (cada caixa/cozinha pode ter uma impressora diferente).
export interface PrintPrefs {
  mode: 'gap' | 'continuous';
  gapMm: number;
  marginMm: number;
  offsetXmm: number;
  offsetYmm: number;
  // Correção do avanço por etiqueta: soma (ou tira) mm na altura de cada página.
  // Etiqueta que desce um pouco a cada impressão = página maior que o passo do rolo -> valor negativo.
  pitchAdjustMm: number;
}
const PREFS_KEY = 'rg_label_print_prefs';
export const DEFAULT_PREFS: PrintPrefs = { mode: 'gap', gapMm: 4, marginMm: 1.5, offsetXmm: 0, offsetYmm: 0, pitchAdjustMm: 0 };
export const loadPrefs = (): PrintPrefs => ({ ...DEFAULT_PREFS, ...storage.get<Partial<PrintPrefs>>(PREFS_KEY, {}) });
export const savePrefs = (p: PrintPrefs) => storage.set(PREFS_KEY, p);

// Onde imprimir: Epson do caixa pelo agente (bobina com corte) ou navegador (impressora de etiqueta 50x30).
export type PrintTarget = 'agent' | 'browser';
const TARGET_KEY = 'rg_label_target';
export const loadTarget = (): PrintTarget => (storage.get<string>(TARGET_KEY, 'agent') === 'browser' ? 'browser' : 'agent');
export const saveTarget = (t: PrintTarget) => storage.set(TARGET_KEY, t);
export const TARGET_LABELS: Record<PrintTarget, string> = { agent: 'Epson do caixa (bobina)', browser: 'Impressora de etiqueta 50x30' };

type Job = { kind: 'labels'; items: LabelData[]; storeName: string } | { kind: 'calibration'; copies: number };

// Monta as etiquetas fora da tela e abre a janela de impressão do navegador.
export function useLabelPrinter() {
  const [job, setJob] = useState<Job | null>(null);
  const [prefs] = useState(loadPrefs);

  useEffect(() => {
    if (!job) return;
    const p = loadPrefs();
    const pageH = Math.round((30 + (p.mode === 'continuous' ? p.gapMm : 0) + (p.pitchAdjustMm || 0)) * 10) / 10;
    const style = document.createElement('style');
    style.id = 'label-page-style';
    style.textContent = `@page { size: 50mm ${pageH}mm; margin: 0; }
      .lbl-page { height: ${pageH}mm; }
      .lbl-page .lbl-sheet { padding: ${p.marginMm}mm; transform: translate(${p.offsetXmm}mm, ${p.offsetYmm}mm); }`;
    document.head.appendChild(style);
    document.body.classList.add('printing-labels');
    const done = () => setJob(null);
    window.addEventListener('afterprint', done, { once: true });
    // Espera o React desenhar as etiquetas antes de abrir a janela de impressão.
    const t = window.setTimeout(() => window.print(), 50);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('printing-labels');
      style.remove();
    };
  }, [job]);

  const printLabels = useCallback((data: LabelData, copies: number, storeName: string) => {
    setJob({ kind: 'labels', items: Array.from({ length: copies }, () => data), storeName });
  }, []);
  const printCalibration = useCallback((copies = 2) => setJob({ kind: 'calibration', copies }), []);

  const portal = job
    ? createPortal(
        <div className="lbl-print-root" aria-hidden="true">
          {job.kind === 'labels'
            ? job.items.map((d, i) => (
                <div className="lbl-page" key={i}><div className="lbl-sheet"><LabelFace data={d} storeName={job.storeName} /></div></div>
              ))
            : Array.from({ length: job.copies }, (_, i) => (
                <div className="lbl-page" key={i}><div className="lbl-sheet"><CalibrationFace n={i + 1} total={job.copies} /></div></div>
              ))}
        </div>,
        document.body,
      )
    : null;

  return { printLabels, printCalibration, portal, busy: !!job, prefs };
}
