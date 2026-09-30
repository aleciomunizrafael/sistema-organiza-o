import { today as todayYmd, addDays, fromYmd, toYmd, weekdayOf, daysInMonth, isValidYmd } from './dates.js';

// Reconhece datas e recorrências escritas em português dentro de um texto livre.
// Ex.: "Enviar relatório até sexta" -> { date: '2026-10-02', cleaned: 'Enviar relatório', isEnd: true }

const WEEKDAYS = [
  ['domingo', 'domingos'],
  ['segunda-feira', 'segunda feira', 'segundas-feiras', 'segundas feiras', 'segundas', 'segunda', '2ª feira', '2a feira', '2ª-feira', '2a-feira', '2ª', '2a'],
  ['terça-feira', 'terca-feira', 'terça feira', 'terca feira', 'terças-feiras', 'tercas-feiras', 'terças', 'tercas', 'terça', 'terca', '3ª feira', '3a feira', '3ª-feira', '3a-feira', '3ª', '3a'],
  ['quarta-feira', 'quarta feira', 'quartas-feiras', 'quartas feiras', 'quartas', 'quarta', '4ª feira', '4a feira', '4ª-feira', '4a-feira', '4ª', '4a'],
  ['quinta-feira', 'quinta feira', 'quintas-feiras', 'quintas feiras', 'quintas', 'quinta', '5ª feira', '5a feira', '5ª-feira', '5a-feira', '5ª', '5a'],
  ['sexta-feira', 'sexta feira', 'sextas-feiras', 'sextas feiras', 'sextas', 'sexta', '6ª feira', '6a feira', '6ª-feira', '6a-feira', '6ª', '6a'],
  ['sábado', 'sabado', 'sábados', 'sabados'],
];
// Abreviações numéricas (2a, 3ª...) só valem com contexto de data (preposição/"próxima") ou com "feira"
const NUMERIC_ABBR = /^\d[aª]$/;

const MONTHS = {
  janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, 'março': 3, mar: 3, abril: 4, abr: 4,
  maio: 5, mai: 5, junho: 6, jun: 6, julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9,
  outubro: 10, out: 10, novembro: 11, nov: 11, dezembro: 12, dez: 12,
};

const PREP_WORDS = 'a\\s+partir\\s+de|at[eé]|para|pra|p\\/|em|no dia|na|no|dia|prazo:?|entrega:?|vence|nesta|nessa|neste|nesse|esta|essa';
const PREP = '(?:\\b(?:' + PREP_WORDS + ')\\s+)?';
const PREP_REQUIRED = '(?:\\b(?:' + PREP_WORDS + ')\\s+)';
const END_PREP = /^\s*(?:at[eé]|vence|prazo|entrega)(?![a-zà-ú])/i;

// Palavras que, após um dia da semana, indicam ordinal ("segunda via", "3a parcela") e não data
const NOT_ORDINAL = '(?!\\s*(?:vias?|parcelas?|etapas?|fases?|vers[aã]o|edi[cç][aã]o|op[cç][aã]o|tentativa|inst[aâ]ncia|turma|s[eé]rie|rodada|chamada|leitura|linha|coluna|p[aá]gina|folha|andar|vez|semestre|trimestre|quinzena|metade|parte|etapa)\\b)';
const NO_WORD_AFTER = '(?![a-zà-ú])';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLengthDesc = (a, b) => b.length - a.length;

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

/** "dia N": neste mês se ainda não passou, senão no próximo mês que tenha esse dia. */
function dayOfMonth(day, base, monthsAhead = 0) {
  const b = fromYmd(base);
  for (let k = monthsAhead; k < monthsAhead + 4; k++) {
    const total = b.getMonth() + k;
    const y = b.getFullYear() + Math.floor(total / 12);
    const m = (total % 12) + 1;
    if (day > daysInMonth(y, m)) continue;
    const d = toYmd(new Date(y, m - 1, day));
    if (k > monthsAhead || d >= base) return d;
  }
  return null;
}

function endOfMonth(base, monthsAhead = 0) {
  const b = fromYmd(base);
  const total = b.getMonth() + monthsAhead;
  const y = b.getFullYear() + Math.floor(total / 12);
  const m = (total % 12) + 1;
  return toYmd(new Date(y, m - 1, daysInMonth(y, m)));
}

const weekdayNames = (wd) => WEEKDAYS[wd].slice().sort(byLengthDesc).map(escapeRe).join('|');
const ALL_WEEKDAY_NAMES = WEEKDAYS.flat().sort(byLengthDesc).map(escapeRe).join('|');

function weekdayIndex(word) {
  const w = word.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 7; i++) if (WEEKDAYS[i].includes(w)) return i;
  return -1;
}

/**
 * Extrai uma data do texto. Retorna { date, cleaned, isEnd } onde date pode ser null
 * e isEnd indica que a data veio com preposição de fim ("até", "prazo", "vence").
 */
export function extractDate(text, base = todayYmd()) {
  if (!text) return { date: null, cleaned: '', isEnd: false };
  let t = ' ' + text + ' ';
  let date = null;
  let isEnd = false;

  const tryReplace = (re, fn) => {
    if (date) return;
    const m = t.match(re);
    if (!m) return;
    const d = fn(m);
    if (!d) return;
    date = d;
    isEnd = END_PREP.test(m[0]);
    t = t.replace(m[0], ' ');
  };

  // ISO yyyy-mm-dd (copiado de algum sistema)
  tryReplace(new RegExp(PREP + '(?<![\\d-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\d-])', 'i'), (m) =>
    buildDate(+m[3], +m[2], +m[1], base));

  // dd/mm, dd/mm/yyyy. Com hífen só quando há ano ou preposição ("itens 3-5" não é data)
  tryReplace(new RegExp(PREP + '(?<![\\d\\-\\/])(\\d{1,2})([\\/\\-])(\\d{1,2})(?:([\\/\\-])(\\d{2,4}))?(?![\\d\\-\\/])(?!\\s*[hH:])', 'i'), (m) => {
    const hasPrep = /^\s*[a-zçéêã\/:.]+\s/i.test(m[0]);
    if (m[2] === '-' && !m[5] && !hasPrep) return null;
    if (m[4] && m[4] !== m[2]) return null;
    return buildDate(+m[1], +m[3], m[5] ? +m[5] : null, base);
  });

  // "15 de outubro", "1º de out", "15 de outubro de 2026"
  tryReplace(new RegExp(PREP + '\\b(\\d{1,2})[ºo°]?\\s+de\\s+([a-zçã]+)(?:\\s+de\\s+(\\d{4}))?\\b', 'i'), (m) => {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? buildDate(+m[1], mo, m[3] ? +m[3] : null, base) : null;
  });

  // "dia 15", "dia 1º", "dia 5 do mês que vem"
  tryReplace(/\b(?:at[eé]|para|pra|no|em|vence|prazo:?|entrega:?)?\s*\bdia\s+(\d{1,2})[ºo°]?(?![\d])(?!\s*[\/\-hH:])(\s+(?:do\s+)?(?:m[eê]s\s+(?:que\s+vem|seguinte)|pr[oó]ximo\s+m[eê]s))?/i, (m) =>
    dayOfMonth(+m[1], base, m[2] ? 1 : 0));

  // relativos
  tryReplace(new RegExp(PREP + '\\bdepois de amanh[aã]' + NO_WORD_AFTER, 'i'), () => addDays(base, 2));
  tryReplace(new RegExp(PREP + '\\bamanh[aã]' + NO_WORD_AFTER + '(?:\\s+cedo)?', 'i'), () => addDays(base, 1));
  tryReplace(new RegExp(PREP + '\\bhoje\\b', 'i'), () => base);
  tryReplace(/\b(?:em|daqui a|daqui)\s+(\d{1,2})\s+dias?\b/i, (m) => addDays(base, +m[1]));
  tryReplace(/\b(?:em|daqui a|daqui)\s+(\d{1,2})\s+semanas?\b/i, (m) => addDays(base, 7 * +m[1]));
  tryReplace(/\b(?:em|daqui a|daqui)\s+uma\s+semana\b/i, () => addDays(base, 7));
  tryReplace(new RegExp(PREP + '\\b(?:na\\s+)?(?:pr[oó]xima\\s+semana|semana\\s+que\\s+vem|semana\\s+seguinte)\\b', 'i'), () => nextWeekday(base, 1, true));
  tryReplace(new RegExp(PREP + '\\b(?:o\\s+)?(?:fim|final)\\s+do\\s+(?:m[eê]s(\\s+(?:que\\s+vem|seguinte))?|(pr[oó]ximo)\\s+m[eê]s)\\b', 'i'), (m) =>
    endOfMonth(base, (m[1] || m[2]) ? 1 : 0));
  tryReplace(new RegExp(PREP + '\\b(?:o\\s+)?(?:fim|final)\\s+da\\s+semana\\b', 'i'), () => nextWeekday(base, 5, false));

  // dias da semana ("até sexta", "na próxima segunda", "segunda que vem", "sexta-feira", "2ª feira")
  if (!date) {
    for (let wd = 0; wd < 7 && !date; wd++) {
      const names = weekdayNames(wd);
      const re = new RegExp(PREP + '\\b(?:(?:na\\s+)?pr[oó]xima\\s+)?(' + names + ')' + NO_WORD_AFTER + '(?:\\s+que\\s+vem)?' + NOT_ORDINAL, 'i');
      tryReplace(re, (m) => {
        const word = m[1].toLowerCase();
        if (NUMERIC_ABBR.test(word)) {
          // "2a" sozinho só é data com preposição ou "próxima" ("até 2a", "próxima 3ª")
          const hasContext = /^\s*(?:[a-zçéêã\/:.]+\s+)+\d/i.test(m[0]) || /pr[oó]xima/i.test(m[0]);
          if (!hasContext) return null;
        }
        return nextWeekday(base, wd, true);
      });
    }
  }

  return { date, cleaned: clean(t), isEnd };
}

/**
 * Extrai uma recorrência escrita ("toda segunda", "toda terça e quinta", "todo dia 5 e 20", "diariamente").
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

  const monthDaysFrom = (list) => {
    const days = [...new Set(list.split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 31))];
    if (!days.length) return null;
    return days.length === 1 ? { freq: 'monthly', interval: 1, monthDay: days[0] } : { freq: 'monthly', interval: 1, monthDays: days.sort((a, b) => a - b) };
  };

  // dias úteis (antes do "todo dia" genérico)
  tryReplace(/\b(?:todo\s+dia\s+[uú]til|todos\s+os\s+dias\s+[uú]teis|(?:nos\s+|aos\s+)?dias\s+[uú]teis|de\s+segunda\s+a\s+sexta(?:-feira)?|de\s+2[ªa]\s+a\s+6[ªa](?:\s+feira)?)\b/i, () => ({
    freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5],
  }));

  // mensal: "todo mês", "todo mês dia 5", "mensalmente no dia 5", "todo dia 5", "todo dia 15 e 30"
  tryReplace(/\b(?:todo\s+m[eê]s|mensalmente|todos\s+os\s+meses)(?:\s+(?:no\s+|nos\s+)?dias?\s+(\d{1,2}(?:\s*(?:,|e|ou)\s*\d{1,2})*))?[ºo°]?\b/i, (m) =>
    m[1] ? monthDaysFrom(m[1]) : { freq: 'monthly', interval: 1 });
  tryReplace(/\btodo\s+dia\s+(\d{1,2}(?:\s*(?:,|e|ou)\s*\d{1,2})*)[ºo°]?\b(?!\s*[\/\-hH:])/i, (m) => monthDaysFrom(m[1]));

  // diária
  tryReplace(/\b(?:todo\s+dia|todos\s+os\s+dias|diariamente|todo\s+santo\s+dia)\b/i, () => ({ freq: 'daily', interval: 1 }));
  tryReplace(/\ba\s+cada\s+(\d{1,2})\s+dias\b/i, (m) => ({ freq: 'daily', interval: Math.max(1, +m[1]) }));

  // semanal / quinzenal / anual
  tryReplace(/\b(?:toda\s+semana|semanalmente|todas\s+as\s+semanas)\b/i, () => ({ freq: 'weekly', interval: 1 }));
  tryReplace(/\b(?:a\s+cada\s+(?:duas|2)\s+semanas|quinzenalmente|de\s+quinze\s+em\s+quinze\s+dias|de\s+15\s+em\s+15\s+dias)\b/i, () => ({ freq: 'weekly', interval: 2 }));
  tryReplace(/\ba\s+cada\s+(\d{1,2})\s+semanas\b/i, (m) => ({ freq: 'weekly', interval: Math.max(1, +m[1]) }));
  tryReplace(/\ba\s+cada\s+(\d{1,2})\s+meses\b/i, (m) => ({ freq: 'monthly', interval: Math.max(1, +m[1]) }));
  tryReplace(/\b(?:todo\s+ano|anualmente|todos\s+os\s+anos)\b/i, () => ({ freq: 'yearly', interval: 1 }));

  // semanal em dias específicos: "toda terça e quinta", "todas as segundas", "às segundas e quartas"
  if (!rule) {
    const DAY = '(?:' + ALL_WEEKDAY_NAMES + ')';
    const SEP = '\\s*(?:,|\\be\\b|\\bou\\b)\\s*(?:as\\s+|às\\s+)?';
    const re = new RegExp('(?<![a-zà-ú])(?:toda|todas\\s+as|todo|todos\\s+os|[àa]s)\\s+(' + DAY + '(?:' + SEP + DAY + ')*)' + NO_WORD_AFTER, 'i');
    tryReplace(re, (m) => {
      const parts = m[1].split(new RegExp(SEP, 'i')).map((p) => p.trim()).filter(Boolean);
      const days = [...new Set(parts.map(weekdayIndex).filter((d) => d >= 0))].sort();
      if (!days.length) return null;
      // "às" exige dia no plural ou mais de um dia, para não casar "às segunda" por engano
      if (/^\s*[àa]s\b/i.test(m[0]) && days.length === 1 && !/s\b/.test(parts[0].replace(/-?feiras?$/i, ''))) return null;
      return { freq: 'weekly', interval: 1, weekdays: days };
    });
  }

  return { rule, cleaned: clean(t) };
}

export { isValidYmd };
