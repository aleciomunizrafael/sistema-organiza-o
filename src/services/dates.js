// Utilitários de data trabalhando com strings 'YYYY-MM-DD' no fuso local.

const pad = (n) => String(n).padStart(2, '0');

export function toYmd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today() {
  return toYmd(new Date());
}

export function addDays(ymd, n) {
  const d = fromYmd(ymd);
  d.setDate(d.getDate() + n);
  return toYmd(d);
}

export function diffDays(a, b) {
  // b - a em dias (ambos YYYY-MM-DD)
  const ms = fromYmd(b).getTime() - fromYmd(a).getTime();
  return Math.round(ms / 86400000);
}

export function daysInMonth(year, month1) {
  return new Date(year, month1, 0).getDate();
}

export function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = fromYmd(s);
  return toYmd(d) === s;
}

export function weekdayOf(ymd) {
  return fromYmd(ymd).getDay(); // 0 = domingo
}

/** Segunda-feira da semana que contém a data. */
export function mondayOf(ymd) {
  const wd = weekdayOf(ymd);
  const back = (wd + 6) % 7;
  return addDays(ymd, -back);
}
