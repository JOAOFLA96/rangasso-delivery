// Normalizações de entrada usadas no checkout e no painel.
export const onlyDigits = (s: string) => s.replace(/\D+/g, '');

export function normalizePhone(raw: string): string | null {
  let d = onlyDigits(raw);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  // DDD (2) + 8 dígitos (fixo) ou 9 dígitos (celular começando com 9)
  if (d.length === 10 || (d.length === 11 && d[2] === '9')) return d;
  return null;
}

export function formatPhone(d: string) {
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

export function normalizeCep(raw: string): string | null {
  const d = onlyDigits(raw);
  return d.length === 8 ? d : null;
}

export const cleanText = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);

export function formatBRL(cents: number) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}R$ ${reais},${String(abs % 100).padStart(2, '0')}`;
}

// Compara nomes de bairro sem acento, caixa ou espaços repetidos ("Pq. Campo Bonito" ainda é diferente de "Parque").
export function normalizeName(raw: string) {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
