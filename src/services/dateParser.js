import { today as todayYmd, addDays, fromYmd, toYmd, weekdayOf, daysInMonth, isValidYmd } from './dates.js';

// Reconhece datas e recorrências escritas em português dentro de um texto livre.
// Ex.: "Enviar relatório até sexta" -> { date: '2026-10-02', cleaned: 'Enviar relatório' }

const WEEKDAYS = [
  ['domingo'], ['segunda', 'segunda-feira', 'segunda feira', '2a', '2ª'],
  ['terca', 'terça', 'terca-feira', 'terça-feira', 'terça feira', 'terca feira', '3a', '3ª'],
  ['quarta', 'quarta-feira', 'quarta feira', '4a', '4ª'],
  ['quinta', 'quinta-feira', 'quinta feira', '5a', '5ª'],
  ['sexta', 'sexta-feira', 'sexta feira', '6a', '6ª'],
  ['sabado', 'sábado'],
];

const MONTHS = {
  janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, 'março': 3, mar: 3, abril: 4, abr: 4,
  maio: 5, mai: 5, junho: 6, jun: 6, julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9,
  outubro: 10, out: 10, novembro: 11, nov: 11, dezembro: 12, dez: 12,
};

const PREP = '(?:\\b(?:at[eé]|para|pra|p\\/|em|no dia|na|no|dia|prazo:?|entrega:?|vence)\\s+)?';

function clean(text) {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:\-–]+|[\s,.;:\-–]+$/g, '')
    .trim();
}

function nextWeekday(base, wd, strictlyAfter = true) {
  const cur = weekdayOf(base);
  let delta = (wd - cur + 7) % 7;
  if (delta === 0 && strictlyAfter) delta = 7;
  return addDays(base, delta);
}

function buildDate(day, month, year, base) {
  const baseD = fromYmd(base);
  let y = year;
  if (y == null) y = baseD.getFullYear();
  else if (y < 100) y += 2000;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(y, month)) return null;
  let result = toYmd(new Date(y, month - 1, day));
  // Sem ano informado e a data já passou há mais de 60 dias -> assume ano seguinte
  if (year == null && result < addDays(base, -60)) {
    result = toYmd(new Date(y + 1, month - 1, Math.min(day, daysInMonth(y + 1, month))));
  }
  return result;
}

/**
 * Extrai uma data do texto. Retorna { date, cleaned } onde date pode ser null.
 */
export function extractDate(text, base = todayYmd()) {
  if (!text) return { date: null, cleaned: '' };
  let t = ' ' + text + ' ';
  let date = null;

  const tryReplace = (re, fn) => {
    if (date) return;
    const m = t.match(re);
    if (!m) return;
    const d = fn(m);
    if (!d) return;
    date = d;
    t = t.replace(m[0], ' ');
  };

  // dd/mm/yyyy ou dd/mm ou dd-mm
  tryReplace(new RegExp(PREP + '\\b(\\d{1,2})[\\/\\-](\\d{1,2})(?:[\\/\\-](\\d{2,4}))?\\b(?!\\s*[hH:])', 'i'), (m) =>
    buildDate(+m[1], +m[2], m[3] ? +m[3] : null, base));

  // "15 de outubro", "15 de out", "15 de outubro de 2026", "dia 15"
  tryReplace(new RegExp(PREP + '\\b(\\d{1,2})\\s+de\\s+([a-zçã]+)(?:\\s+de\\s+(\\d{4}))?\\b', 'i'), (m) => {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? buildDate(+m[1], mo, m[3] ? +m[3] : null, base) : null;
  });
  tryReplace(/\b(?:at[eé]|para|pra|no|em o)?\s*\bdia\s+(\d{1,2})\b(?!\s*[\/\-hH:])/i, (m) => {
    const b = fromYmd(base);
    let d = buildDate(+m[1], b.getMonth() + 1, b.getFullYear(), base);
    if (d && d < base) {
      const nm = b.getMonth() + 2;
      const y = nm > 12 ? b.getFullYear() + 1 : b.getFullYear();
      d = buildDate(+m[1], ((nm - 1) % 12) + 1, y, base);
    }
    return d;
  });

  // relativos
  tryReplace(new RegExp(PREP + '\\bdepois de amanh[aã](?![a-zà-ú])', 'i'), () => addDays(base, 2));
  tryReplace(new RegExp(PREP + '\\bamanh[aã](?![a-zà-ú])', 'i'), () => addDays(base, 1));
  tryReplace(new RegExp(PREP + '\\bhoje\\b', 'i'), () => base);
  tryReplace(/\b(?:em|daqui a|daqui)\s+(\d{1,2})\s+dias?\b/i, (m) => addDays(base, +m[1]));
  tryReplace(/\b(?:em|daqui a|daqui)\s+(\d{1,2})\s+semanas?\b/i, (m) => addDays(base, 7 * +m[1]));
  tryReplace(/\b(?:em|daqui a|daqui)\s+uma\s+semana\b/i, () => addDays(base, 7));
  tryReplace(new RegExp(PREP + '\\b(?:na\\s+)?pr[oó]xima\\s+semana\\b', 'i'), () => nextWeekday(base, 1, true));
  tryReplace(new RegExp(PREP + '\\b(?:o\\s+)?(?:fim|final)\\s+do\\s+m[eê]s\\b', 'i'), () => {
    const b = fromYmd(base);
    return toYmd(new Date(b.getFullYear(), b.getMonth(), daysInMonth(b.getFullYear(), b.getMonth() + 1)));
  });
  tryReplace(new RegExp(PREP + '\\b(?:o\\s+)?(?:fim|final)\\s+da\\s+semana\\b', 'i'), () => nextWeekday(base, 5, false));

  // dias da semana ("até sexta", "na próxima segunda", "sexta-feira")
  if (!date) {
    for (let wd = 0; wd < 7 && !date; wd++) {
      const names = WEEKDAYS[wd].map((n) => n.replace(/[-\/]/g, '\\$&')).join('|');
      const re = new RegExp(PREP + '\\b(?:(?:na\\s+)?pr[oó]xima\\s+)?(?:' + names + ')\\b(?:-feira)?', 'i');
      tryReplace(re, () => nextWeekday(base, wd, true));
    }
  }

  return { date, cleaned: clean(t) };
}

/**
 * Extrai uma recorrência escrita ("toda segunda", "todo dia 5", "diariamente").
 * Retorna { rule, cleaned } onde rule pode ser null.
 */
export function extractRecurrence(text) {
  if (!text) return { rule: null, cleaned: '' };
  let t = ' ' + text + ' ';
  let rule = null;

  const tryReplace = (re, fn) => {
    if (rule) return;
    const m = t.match(re);
    if (!m) return;
    const r = fn(m);
    if (!r) return;
    rule = r;
    t = t.replace(m[0], ' ');
  };

  tryReplace(/\b(?:todo\s+m[eê]s|mensalmente|todos\s+os\s+meses)(?:\s+(?:no\s+)?dia\s+(\d{1,2}))?\b/i, (m) => ({
    freq: 'monthly', interval: 1, ...(m[1] ? { monthDay: +m[1] } : {}),
  }));
  tryReplace(/\btodo\s+dia\s+(\d{1,2})\b/i, (m) => ({ freq: 'monthly', interval: 1, monthDay: +m[1] }));
  tryReplace(/\b(?:todo\s+dia|todos\s+os\s+dias|diariamente)\b/i, () => ({ freq: 'daily', interval: 1 }));
  tryReplace(/\b(?:todo\s+dia\s+[uú]til|dias\s+[uú]teis|de\s+segunda\s+a\s+sexta)\b/i, () => ({
    freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5],
  }));
  tryReplace(/\b(?:toda\s+semana|semanalmente|todas\s+as\s+semanas)\b/i, () => ({ freq: 'weekly', interval: 1 }));
  tryReplace(/\b(?:a\s+cada\s+(?:duas|2)\s+semanas|quinzenalmente)\b/i, () => ({ freq: 'weekly', interval: 2 }));
  tryReplace(/\b(?:todo\s+ano|anualmente)\b/i, () => ({ freq: 'yearly', interval: 1 }));

  if (!rule) {
    for (let wd = 0; wd < 7 && !rule; wd++) {
      const names = WEEKDAYS[wd].map((n) => n.replace(/[-\/]/g, '\\$&')).join('|');
      const re = new RegExp('\\b(?:toda|todas\\s+as|todo|todos\\s+os)\\s+(?:' + names + ')s?\\b(?:-feiras?)?', 'i');
      tryReplace(re, () => ({ freq: 'weekly', interval: 1, weekdays: [wd] }));
    }
  }

  return { rule, cleaned: clean(t) };
}

export { isValidYmd };
