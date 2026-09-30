import { fromYmd, toYmd, addDays, diffDays, daysInMonth, mondayOf, weekdayOf } from './dates.js';

/**
 * Regra de recorrência (JSON armazenado no modelo):
 * {
 *   freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
 *   interval: 1,                 // a cada N dias/semanas/meses/anos
 *   weekdays: [1,2,3,4,5],       // só weekly; 0 = domingo ... 6 = sábado
 *   monthDay: 5,                 // só monthly; padrão = dia da âncora
 *   until: 'YYYY-MM-DD' | null   // data final opcional
 * }
 * A âncora é a data de início do modelo (start_date).
 */

export const PRESETS = {
  daily: { freq: 'daily', interval: 1 },
  weekdays: { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] },
  weekly: { freq: 'weekly', interval: 1 },
  biweekly: { freq: 'weekly', interval: 2 },
  monthly: { freq: 'monthly', interval: 1 },
  yearly: { freq: 'yearly', interval: 1 },
};

export function normalizeRule(rule) {
  if (!rule) return null;
  if (typeof rule === 'string') {
    if (PRESETS[rule]) return { ...PRESETS[rule] };
    try { rule = JSON.parse(rule); } catch { return null; }
  }
  if (!rule || !['daily', 'weekly', 'monthly', 'yearly'].includes(rule.freq)) return null;
  const out = { freq: rule.freq, interval: Math.max(1, parseInt(rule.interval, 10) || 1) };
  if (rule.freq === 'weekly' && Array.isArray(rule.weekdays) && rule.weekdays.length) {
    out.weekdays = [...new Set(rule.weekdays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  }
  if (rule.freq === 'monthly' && rule.monthDay) {
    out.monthDay = Math.min(31, Math.max(1, parseInt(rule.monthDay, 10)));
  }
  if (rule.until) out.until = rule.until;
  return out;
}

/** A data `date` é uma ocorrência da regra ancorada em `anchor`? */
export function matches(rule, anchor, date) {
  if (date < anchor) return false;
  if (rule.until && date > rule.until) return false;
  const a = fromYmd(anchor);
  const d = fromYmd(date);
  const interval = rule.interval || 1;

  switch (rule.freq) {
    case 'daily':
      return diffDays(anchor, date) % interval === 0;

    case 'weekly': {
      const weekdays = rule.weekdays && rule.weekdays.length ? rule.weekdays : [weekdayOf(anchor)];
      if (!weekdays.includes(d.getDay())) return false;
      const weeks = Math.floor(diffDays(mondayOf(anchor), date) / 7);
      return weeks % interval === 0;
    }

    case 'monthly': {
      const months = (d.getFullYear() - a.getFullYear()) * 12 + (d.getMonth() - a.getMonth());
      if (months % interval !== 0) return false;
      const wanted = rule.monthDay || a.getDate();
      const day = Math.min(wanted, daysInMonth(d.getFullYear(), d.getMonth() + 1));
      return d.getDate() === day;
    }

    case 'yearly': {
      const years = d.getFullYear() - a.getFullYear();
      if (years % interval !== 0) return false;
      if (d.getMonth() !== a.getMonth()) return false;
      const day = Math.min(a.getDate(), daysInMonth(d.getFullYear(), d.getMonth() + 1));
      return d.getDate() === day;
    }
    default:
      return false;
  }
}

/** Primeira ocorrência >= from (inclusive). Retorna null se não houver em ~10 anos. */
export function nextOccurrence(rule, anchor, from, maxDays = 3660) {
  let date = from < anchor ? anchor : from;
  for (let i = 0; i < maxDays; i++) {
    if (rule.until && date > rule.until) return null;
    if (matches(rule, anchor, date)) return date;
    date = addDays(date, 1);
  }
  return null;
}

/** Última ocorrência <= to (inclusive) e >= anchor, ou null. */
export function lastOccurrenceUpTo(rule, anchor, to, maxDays = 3660) {
  let date = rule.until && to > rule.until ? rule.until : to;
  for (let i = 0; i < maxDays && date >= anchor; i++) {
    if (matches(rule, anchor, date)) return date;
    date = addDays(date, -1);
  }
  return null;
}

const WEEKDAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function describeRule(rule) {
  if (!rule) return '';
  const n = rule.interval || 1;
  switch (rule.freq) {
    case 'daily':
      return n === 1 ? 'Todos os dias' : `A cada ${n} dias`;
    case 'weekly': {
      const wd = rule.weekdays || [];
      const isWeekdays = wd.length === 5 && [1, 2, 3, 4, 5].every((x) => wd.includes(x));
      if (isWeekdays && n === 1) return 'Dias úteis';
      const days = wd.length ? ' (' + wd.map((x) => WEEKDAY_NAMES[x]).join(', ') + ')' : '';
      if (n === 1) return 'Toda semana' + days;
      if (n === 2) return 'A cada 2 semanas' + days;
      return `A cada ${n} semanas` + days;
    }
    case 'monthly': {
      const day = rule.monthDay ? ` no dia ${rule.monthDay}` : '';
      return (n === 1 ? 'Todo mês' : `A cada ${n} meses`) + day;
    }
    case 'yearly':
      return n === 1 ? 'Todo ano' : `A cada ${n} anos`;
    default:
      return '';
  }
}

export { toYmd };
