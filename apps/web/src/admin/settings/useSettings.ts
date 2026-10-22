import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

export interface SettingsData {
  settings: Record<string, any>;
  openState: { open: boolean; reason: string; nextOpening: string | null };
  hours: { weekday: number; opensAt: string; closesAt: string }[];
  closures: { id: string; date: string; reason: string }[];
  distance: { mode: 'neighborhood' | 'distance'; storeLat: number | null; storeLng: number | null; tiers: { maxKm: number; feeCents: number }[] };
  neighborhoods: { id: string; name: string; city: string; feeCents: number; minOrderCents: number | null; active: boolean; feePending?: boolean }[];
}

export function useSettings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<SettingsData>('/api/admin/settings'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

export const centsToInput = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
export function inputToCents(v: string): number | null {
  const t = v.trim().replace(/\s|R\$/g, '');
  if (!t) return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}
