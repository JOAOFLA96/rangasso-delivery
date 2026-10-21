// Regras de horário de funcionamento, sempre no fuso da loja (padrão America/Sao_Paulo).

export interface Shift { weekday: number; opens_at: string; closes_at: string }
export type OpenMode = 'auto' | 'force_open' | 'force_closed';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAY_NAMES_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function localParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAYS.indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface OpenState { open: boolean; reason: 'forced_open' | 'forced_closed' | 'closure' | 'schedule' | 'no_schedule'; nextOpening: string | null }

export function computeOpenState(now: Date, timeZone: string, mode: OpenMode, shifts: Shift[], closedDates: Set<string>): OpenState {
  if (mode === 'force_open') return { open: true, reason: 'forced_open', nextOpening: null };
  const { date, weekday, minutes } = localParts(now, timeZone);
  const next = () => nextOpening(date, weekday, minutes, shifts, closedDates);
  if (mode === 'force_closed') return { open: false, reason: 'forced_closed', nextOpening: null };
  if (shifts.length === 0) return { open: false, reason: 'no_schedule', nextOpening: null };

  const today = closedDates.has(date) ? [] : shifts.filter((s) => s.weekday === weekday);
  for (const s of today) {
    const o = toMin(s.opens_at), c = toMin(s.closes_at);
    if (c > o ? minutes >= o && minutes < c : minutes >= o) return { open: true, reason: 'schedule', nextOpening: null };
  }
  const yDate = addDays(date, -1);
  const yesterday = closedDates.has(yDate) ? [] : shifts.filter((s) => s.weekday === (weekday + 6) % 7);
  for (const s of yesterday) {
    const o = toMin(s.opens_at), c = toMin(s.closes_at);
    if (c <= o && minutes < c) return { open: true, reason: 'schedule', nextOpening: null };
  }
  return { open: false, reason: closedDates.has(date) ? 'closure' : 'schedule', nextOpening: next() };
}

function nextOpening(date: string, weekday: number, minutes: number, shifts: Shift[], closedDates: Set<string>): string | null {
  for (let i = 0; i < 8; i++) {
    const d = addDays(date, i);
    if (closedDates.has(d)) continue;
    const wd = (weekday + i) % 7;
    const candidates = shifts
      .filter((s) => s.weekday === wd)
      .map((s) => toMin(s.opens_at))
      .filter((o) => i > 0 || o > minutes)
      .sort((a, b) => a - b);
    if (candidates.length) {
      const hhmm = `${String(Math.floor(candidates[0] / 60)).padStart(2, '0')}:${String(candidates[0] % 60).padStart(2, '0')}`;
      const day = i === 0 ? 'hoje' : i === 1 ? 'amanhã' : WEEKDAY_NAMES_PT[wd];
      return `${day} às ${hhmm}`;
    }
  }
  return null;
}
