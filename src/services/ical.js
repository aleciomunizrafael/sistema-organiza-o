import { randomBytes } from 'node:crypto';
import { getDb, getState, setState } from '../db/database.js';
import { nextOccurrence } from './recurrence.js';
import { today as todayYmd, addDays } from './dates.js';

/**
 * Calendário iCalendar (.ics) para assinar no Google Agenda, Outlook ou iPhone.
 * Protegido por um token secreto no endereço (não passa pelo login).
 */

export function calendarToken({ rotate = false } = {}) {
  let t = getState('ical_token');
  if (!t || rotate) {
    t = randomBytes(24).toString('hex');
    setState('ical_token', t);
  }
  return t;
}

const ymdCompact = (ymd) => ymd.replace(/-/g, '');
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function esc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Quebra linhas com mais de 75 bytes (RFC 5545). */
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

function utcStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** 'YYYY-MM-DDTHH:MM' em hora local do servidor -> UTC compacto. */
function localToUtc(local) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return utcStamp(new Date(y, m - 1, d, hh, mm, 0));
}

export function rruleFor(rule, anchor) {
  const parts = [];
  const n = rule.interval || 1;
  switch (rule.freq) {
    case 'daily': parts.push('FREQ=DAILY'); break;
    case 'weekly': {
      parts.push('FREQ=WEEKLY', 'WKST=MO');
      if (rule.weekdays?.length) parts.push('BYDAY=' + rule.weekdays.map((w) => WD[w]).join(','));
      break;
    }
    case 'monthly': {
      parts.push('FREQ=MONTHLY');
      const days = rule.monthDays?.length ? rule.monthDays : [rule.monthDay || Number(anchor.slice(8, 10))];
      parts.push('BYMONTHDAY=' + days.join(','));
      break;
    }
    case 'yearly': parts.push('FREQ=YEARLY'); break;
    default: return null;
  }
  if (n > 1) parts.push(`INTERVAL=${n}`);
  if (rule.until) parts.push(`UNTIL=${ymdCompact(rule.until)}`);
  return parts.join(';');
}

function event({ uid, summary, description, date, start, durationMin = 30, rrule, exdates = [], updated, url }) {
  const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utcStamp()}`];
  if (updated) lines.push(`LAST-MODIFIED:${utcStamp(new Date(updated))}`);
  if (date) {
    lines.push(`DTSTART;VALUE=DATE:${ymdCompact(date)}`, `DTEND;VALUE=DATE:${ymdCompact(addDays(date, 1))}`);
  } else {
    const s = localToUtc(start);
    const [d, t] = start.split('T');
    const [hh, mm] = t.split(':').map(Number);
    const end = new Date(...d.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), hh, mm + durationMin);
    lines.push(`DTSTART:${s}`, `DTEND:${utcStamp(end)}`);
  }
  if (rrule) lines.push(`RRULE:${rrule}`);
  for (const ex of exdates) lines.push(`EXDATE;VALUE=DATE:${ymdCompact(ex)}`);
  lines.push(`SUMMARY:${esc(summary)}`);
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  return lines;
}

export function buildCalendar({ baseUrl = '' } = {}, today = todayYmd()) {
  const db = getDb();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Organiza//Tarefas//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Organiza', 'X-WR-TIMEZONE:' + (process.env.TZ || 'America/Sao_Paulo'), 'X-PUBLISHED-TTL:PT1H',
  ];
  const link = baseUrl ? `${baseUrl}/#today` : undefined;

  // Tarefas comuns abertas com data (prazo ou entrada na lista) ou lembrete
  const tasks = db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0
    AND (due_date IS NOT NULL OR start_date IS NOT NULL OR remind_at IS NOT NULL)`).all();
  for (const t of tasks) {
    const title = (t.priority ? '! ' : '') + t.title;
    const desc = [t.notes, t.source === 'whatsapp' && t.source_sender ? `Pedido por ${t.source_sender} (WhatsApp)` : ''].filter(Boolean).join('\n');
    if (t.due_date) {
      lines.push(...event({ uid: `task-${t.id}@organiza`, summary: title, description: desc, date: t.due_date, updated: t.updated_at, url: link }));
    } else if (t.start_date && t.start_date > today && !t.template_id) {
      lines.push(...event({ uid: `task-${t.id}@organiza`, summary: `${title} (entra na lista)`, description: desc, date: t.start_date, updated: t.updated_at, url: link }));
    }
    if (t.remind_at && !t.reminded_at) {
      lines.push(...event({ uid: `remind-${t.id}@organiza`, summary: `⏰ ${t.title}`, description: desc, start: t.remind_at, updated: t.updated_at, url: link }));
    }
  }

  // Recorrências ativas (como eventos recorrentes), sem as datas puladas
  const templates = db.prepare('SELECT * FROM tasks WHERE is_template = 1 AND completed_at IS NULL AND recurrence IS NOT NULL').all();
  for (const tpl of templates) {
    const rule = JSON.parse(tpl.recurrence);
    const anchor = tpl.start_date || today;
    const first = nextOccurrence(rule, anchor, anchor);
    if (!first) continue;
    const rrule = rruleFor(rule, anchor);
    if (!rrule) continue;
    const exdates = db.prepare('SELECT occurrence_date FROM skipped_occurrences WHERE template_id = ?').all(tpl.id).map((r) => r.occurrence_date);
    lines.push(...event({
      uid: `recur-${tpl.id}@organiza`, summary: `↻ ${tpl.priority ? '! ' : ''}${tpl.title}`, description: tpl.notes,
      date: first, rrule, exdates, updated: tpl.updated_at, url: link,
    }));
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
