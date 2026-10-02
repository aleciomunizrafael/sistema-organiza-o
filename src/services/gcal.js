import fs from 'node:fs';
import path from 'node:path';
import { createSign } from 'node:crypto';
import { config } from '../config.js';
import { getDb, getSettings, getState, setState, nowIso } from '../db/database.js';
import { nextOccurrence } from './recurrence.js';
import { today as todayYmd, addDays } from './dates.js';
import { rruleFor } from './ical.js';

/**
 * Integração com a API do Google Agenda por "conta de serviço":
 * - envia tarefas com prazo e recorrências como eventos (sincronização contínua);
 * - lê os compromissos da agenda para mostrar no Bloco da semana.
 * A chave JSON da conta de serviço fica em data/google-service-account.json.
 */

const CRED_FILE = path.join(config.dataDir, 'google-service-account.json');
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';

let log = { info() {}, warn() {}, error() {} };
export function setLogger(l) { log = l; }

// Permite trocar o fetch nos testes
let fetchImpl = (...a) => globalThis.fetch(...a);
export function setFetch(f) { fetchImpl = f; }

const status = { lastSyncAt: null, lastSyncResult: null, lastError: null };
let tokenCache = { token: null, exp: 0 };
let syncTimer = null;
let syncing = false;
const eventsCache = new Map(); // chave -> { at, events }

// ---------- credenciais ----------

export function hasCredentials() {
  return fs.existsSync(CRED_FILE);
}

export function readCredentials() {
  if (!hasCredentials()) return null;
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return null; }
}

export function saveCredentials(json) {
  let obj = json;
  if (typeof json === 'string') { try { obj = JSON.parse(json); } catch { throw new Error('O conteúdo não é um JSON válido'); } }
  if (!obj || obj.type !== 'service_account' || !obj.client_email || !obj.private_key || !obj.token_uri) {
    throw new Error('Isto não parece a chave JSON de uma conta de serviço do Google (faltam client_email, private_key ou token_uri)');
  }
  fs.writeFileSync(CRED_FILE, JSON.stringify(obj), { mode: 0o600 });
  tokenCache = { token: null, exp: 0 };
  eventsCache.clear();
  return { client_email: obj.client_email };
}

export function removeCredentials() {
  fs.rmSync(CRED_FILE, { force: true });
  tokenCache = { token: null, exp: 0 };
  eventsCache.clear();
}

// ---------- token (JWT RS256 -> access token) ----------

const b64url = (s) => Buffer.from(s).toString('base64url');

export function buildJwt(creds, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: creds.token_uri, iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(creds.private_key, 'base64url');
  return `${header}.${claims}.${sig}`;
}

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const creds = readCredentials();
  if (!creds) throw new Error('Chave da conta de serviço não configurada');
  const res = await fetchImpl(creds.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildJwt(creds) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Google recusou a chave: ${data.error_description || data.error || res.status}`);
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function gapi(method, pathOrUrl, body) {
  const token = await accessToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : API + pathOrUrl;
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- configuração ----------

function cfg() {
  const s = getSettings();
  const writeId = (s.gcal_calendar_id || '').trim();
  const readIds = (s.gcal_read_ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    writeId,
    readIds: readIds.length ? readIds : (writeId ? [writeId] : []),
    push: s.gcal_push === '1' && Boolean(writeId),
    pull: s.gcal_pull === '1',
  };
}

export function getStatus() {
  const creds = readCredentials();
  const c = cfg();
  return {
    configured: Boolean(creds) && Boolean(c.writeId),
    client_email: creds?.client_email || null,
    calendar_id: c.writeId,
    read_ids: c.readIds,
    push: c.push,
    pull: c.pull,
    ...status,
    mapped: Number(getDb().prepare('SELECT COUNT(*) n FROM gcal_events').get().n),
  };
}

/** Testa a chave e o acesso à agenda configurada. */
export async function testConnection() {
  const c = cfg();
  if (!c.writeId) throw new Error('Informe o ID da agenda (normalmente o seu e-mail do Google)');
  const cal = await gapi('GET', `/calendars/${encodeURIComponent(c.writeId)}`);
  // tenta listar 1 evento para confirmar permissão de leitura
  await gapi('GET', `/calendars/${encodeURIComponent(c.writeId)}/events?maxResults=1`);
  return { ok: true, summary: cal.summary, timeZone: cal.timeZone };
}

// ---------- tarefas -> eventos ----------

function fingerprint(ev) {
  return JSON.stringify([ev.summary, ev.description, ev.start, ev.end, ev.recurrence]);
}

/** Eventos desejados a partir das tarefas (chave = task id). */
export function desiredEvents(today = todayYmd(), baseUrl = '') {
  const db = getDb();
  const out = new Map();
  const link = baseUrl ? `\n${baseUrl}/#today` : '';
  const tasks = db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0 AND due_date IS NOT NULL`).all();
  for (const t of tasks) {
    out.set(t.id, {
      summary: (t.priority ? '! ' : '') + t.title,
      description: [t.notes, t.source === 'whatsapp' && t.source_sender ? `Pedido por ${t.source_sender} (WhatsApp)` : ''].filter(Boolean).join('\n') + link,
      start: { date: t.due_date },
      end: { date: addDays(t.due_date, 1) },
      transparency: 'transparent',
      extendedProperties: { private: { organizaTaskId: String(t.id) } },
    });
  }
  const templates = db.prepare('SELECT * FROM tasks WHERE is_template = 1 AND completed_at IS NULL AND recurrence IS NOT NULL').all();
  for (const tpl of templates) {
    const rule = JSON.parse(tpl.recurrence);
    const anchor = tpl.start_date || today;
    const first = nextOccurrence(rule, anchor, anchor);
    const rrule = rruleFor(rule, anchor);
    if (!first || !rrule) continue;
    const ex = db.prepare('SELECT occurrence_date FROM skipped_occurrences WHERE template_id = ?').all(tpl.id)
      .map((r) => `EXDATE;VALUE=DATE:${r.occurrence_date.replace(/-/g, '')}`);
    out.set(tpl.id, {
      summary: `↻ ${tpl.priority ? '! ' : ''}${tpl.title}`,
      description: (tpl.notes || '') + link,
      start: { date: first },
      end: { date: addDays(first, 1) },
      recurrence: [`RRULE:${rrule}`, ...ex],
      transparency: 'transparent',
      extendedProperties: { private: { organizaTaskId: String(tpl.id) } },
    });
  }
  return out;
}

/** Sincroniza as tarefas com a agenda: cria, atualiza e remove eventos conforme necessário. */
export async function syncTasksToCalendar({ baseUrl = '' } = {}) {
  const c = cfg();
  if (!c.push || !hasCredentials()) return { skipped: true };
  if (syncing) return { skipped: true, reason: 'em andamento' };
  syncing = true;
  const db = getDb();
  const result = { created: 0, updated: 0, deleted: 0, errors: 0 };
  try {
    const desired = desiredEvents(todayYmd(), baseUrl);
    const mapped = new Map(db.prepare('SELECT * FROM gcal_events').all().map((r) => [r.task_id, r]));
    const calPath = `/calendars/${encodeURIComponent(c.writeId)}/events`;

    for (const [taskId, ev] of desired) {
      const fp = fingerprint(ev);
      const m = mapped.get(taskId);
      try {
        if (!m || m.calendar_id !== c.writeId) {
          if (m) { try { await gapi('DELETE', `/calendars/${encodeURIComponent(m.calendar_id)}/events/${m.event_id}`); } catch { /* ignore */ } }
          const created = await gapi('POST', calPath, ev);
          db.prepare('INSERT OR REPLACE INTO gcal_events (task_id, event_id, calendar_id, fingerprint, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(taskId, created.id, c.writeId, fp, nowIso());
          result.created++;
        } else if (m.fingerprint !== fp) {
          try {
            await gapi('PATCH', `${calPath}/${m.event_id}`, ev);
            result.updated++;
          } catch (e) {
            if (e.status !== 404 && e.status !== 410) throw e;
            const created = await gapi('POST', calPath, ev); // evento apagado no Google: recria
            db.prepare('UPDATE gcal_events SET event_id = ? WHERE task_id = ?').run(created.id, taskId);
            result.created++;
          }
          db.prepare('UPDATE gcal_events SET fingerprint = ?, updated_at = ? WHERE task_id = ?').run(fp, nowIso(), taskId);
        }
      } catch (e) {
        result.errors++;
        log.warn({ taskId, err: e.message }, 'falha ao sincronizar evento');
      }
    }

    for (const [taskId, m] of mapped) {
      if (desired.has(taskId)) continue;
      try {
        await gapi('DELETE', `/calendars/${encodeURIComponent(m.calendar_id)}/events/${m.event_id}`);
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) { result.errors++; log.warn({ taskId, err: e.message }, 'falha ao remover evento'); continue; }
      }
      db.prepare('DELETE FROM gcal_events WHERE task_id = ?').run(taskId);
      result.deleted++;
    }
    status.lastSyncAt = nowIso();
    status.lastSyncResult = result;
    status.lastError = null;
    if (result.created || result.updated || result.deleted) log.info(result, 'agenda do Google sincronizada');
    eventsCache.clear();
    return result;
  } catch (e) {
    status.lastError = e.message;
    log.error({ err: e.message }, 'erro ao sincronizar com o Google Agenda');
    throw e;
  } finally {
    syncing = false;
  }
}

/** Agenda uma sincronização em alguns segundos (chamado após mudanças nas tarefas). */
export function scheduleSync(delayMs = 8000) {
  if (!cfg().push || !hasCredentials()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncTasksToCalendar().catch(() => {}), delayMs);
}

// ---------- eventos -> bloco da semana ----------

function localYmd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function localHm(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Compromissos da(s) agenda(s) entre start e end (YYYY-MM-DD, inclusivos), sem os eventos criados pelo Organiza. */
export async function fetchEvents(start, end) {
  const c = cfg();
  if (!c.pull || !hasCredentials() || !c.readIds.length) return [];
  const key = `${c.readIds.join('|')}|${start}|${end}`;
  const cached = eventsCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.events;

  const tmin = new Date(`${start}T00:00:00`).toISOString();
  const tmax = new Date(`${addDays(end, 1)}T00:00:00`).toISOString();
  const events = [];
  for (const id of c.readIds) {
    try {
      let pageToken = '';
      do {
        const q = new URLSearchParams({ timeMin: tmin, timeMax: tmax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
        if (pageToken) q.set('pageToken', pageToken);
        const data = await gapi('GET', `/calendars/${encodeURIComponent(id)}/events?${q}`);
        for (const e of data.items || []) {
          if (e.status === 'cancelled') continue;
          if (e.extendedProperties?.private?.organizaTaskId) continue;
          const allDay = Boolean(e.start?.date);
          const startD = allDay ? null : new Date(e.start.dateTime);
          const endD = allDay ? null : new Date(e.end?.dateTime || e.start.dateTime);
          // evento de dia inteiro pode durar vários dias: um item por dia
          const firstDay = allDay ? e.start.date : localYmd(startD);
          const lastDay = allDay ? addDays(e.end?.date || e.start.date, -1) : localYmd(endD);
          for (let day = firstDay; day <= lastDay && day <= end; day = addDays(day, 1)) {
            if (day < start) continue;
            events.push({
              id: `${id}:${e.id}:${day}`,
              title: e.summary || '(sem título)',
              date: day,
              time: allDay ? null : (day === firstDay ? localHm(startD) : '00:00'),
              end_time: allDay ? null : (day === lastDay ? localHm(endD) : '23:59'),
              all_day: allDay,
              location: e.location || '',
              link: e.htmlLink || '',
              calendar: id,
            });
          }
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
    } catch (e) {
      status.lastError = `leitura de ${id}: ${e.message}`;
      log.warn({ calendar: id, err: e.message }, 'falha ao ler agenda do Google');
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
  eventsCache.set(key, { at: Date.now(), events });
  return events;
}

export function clearCache() { eventsCache.clear(); }
export const __test = { fingerprint, status };
