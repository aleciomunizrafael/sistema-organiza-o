import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { useMemoryDb, setSettings } from '../src/db/database.js';
import { createTask, updateTask, deleteTask, listTasks } from '../src/services/tasks.js';
import * as gcal from '../src/services/gcal.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CREDS = {
  type: 'service_account', client_email: 'organiza@proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token',
};

/** API falsa do Google: guarda eventos em memória. */
function fakeGoogle() {
  const events = new Map();
  let nextId = 1;
  const calls = [];
  gcal.setFetch(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${url}`);
    const json = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (url === CREDS.token_uri) return json(200, { access_token: 'tok', expires_in: 3600 });
    const u = new URL(url);
    const m = u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (u.pathname.match(/\/calendars\/[^/]+$/)) return json(200, { summary: 'Minha agenda', timeZone: 'America/Sao_Paulo' });
    if (!m) return json(404, { error: { message: 'rota' } });
    const [, , id] = m;
    if (method === 'GET' && !id) {
      return json(200, { items: [...events.values()] });
    }
    if (method === 'POST') { const ev = { ...JSON.parse(opts.body), id: `ev${nextId++}` }; events.set(ev.id, ev); return json(200, ev); }
    if (method === 'PATCH') { if (!events.has(id)) return json(404, { error: { message: 'gone' } }); events.set(id, { ...events.get(id), ...JSON.parse(opts.body) }); return json(200, events.get(id)); }
    if (method === 'DELETE') { if (!events.has(id)) return json(404, { error: { message: 'gone' } }); events.delete(id); return { status: 204, ok: true, json: async () => null }; }
    return json(400, { error: { message: 'inesperado' } });
  });
  return { events, calls };
}

beforeEach(() => {
  useMemoryDb();
  gcal.removeCredentials();
  gcal.clearCache();
});

test('chave: validação e JWT assinado', () => {
  assert.throws(() => gcal.saveCredentials('{"foo":1}'), /conta de serviço/);
  assert.throws(() => gcal.saveCredentials('nao é json'), /JSON válido/);
  const r = gcal.saveCredentials(JSON.stringify(CREDS));
  assert.equal(r.client_email, CREDS.client_email);
  assert.equal(gcal.hasCredentials(), true);
  const jwt = gcal.buildJwt(CREDS, 1000);
  const [h, c] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
  assert.equal(h.alg, 'RS256');
  assert.equal(c.iss, CREDS.client_email);
  assert.equal(c.exp, 4600);
  assert.match(c.scope, /auth\/calendar$/);
  gcal.removeCredentials();
  assert.equal(fs.existsSync, fs.existsSync);
});

test('eventos desejados: prazos e recorrências, sem concluídas nem "sem data"', () => {
  createTask({ title: 'Prazo', due_date: '2026-10-10', priority: true });
  createTask({ title: 'Sem nada' });
  createTask({ title: 'Guardada', someday: true });
  const tpl = createTask({ title: 'Mensal', recurrence: { freq: 'monthly', interval: 1, monthDay: 5 }, start_date: '2026-10-01' });
  const d = gcal.desiredEvents('2026-10-01', 'https://x');
  assert.equal(d.size, 2);
  const prazo = [...d.values()].find((e) => e.summary === '! Prazo');
  assert.deepEqual(prazo.start, { date: '2026-10-10' });
  assert.deepEqual(prazo.end, { date: '2026-10-11' });
  const rec = d.get(tpl.id);
  assert.equal(rec.summary, '↻ Mensal');
  assert.deepEqual(rec.recurrence, ['RRULE:FREQ=MONTHLY;BYMONTHDAY=5']);
  assert.deepEqual(rec.start, { date: '2026-10-05' });
});

test('sincronização cria, atualiza e remove eventos conforme as tarefas mudam', async () => {
  const g = fakeGoogle();
  gcal.saveCredentials(JSON.stringify(CREDS));
  setSettings({ gcal_calendar_id: 'eu@gmail.com', gcal_push: '1' });
  const t = createTask({ title: 'Entregar', due_date: '2026-10-10' });
  let r = await gcal.syncTasksToCalendar();
  assert.deepEqual(r, { created: 1, updated: 0, deleted: 0, errors: 0 });
  assert.equal(g.events.size, 1);
  assert.equal([...g.events.values()][0].extendedProperties.private.organizaTaskId, String(t.id));
  // sem mudanças: nada a fazer
  r = await gcal.syncTasksToCalendar();
  assert.deepEqual(r, { created: 0, updated: 0, deleted: 0, errors: 0 });
  // mudou o prazo: atualiza
  updateTask(t.id, { due_date: '2026-10-12' });
  r = await gcal.syncTasksToCalendar();
  assert.equal(r.updated, 1);
  assert.equal([...g.events.values()][0].start.date, '2026-10-12');
  // evento apagado no Google: recria
  g.events.clear();
  updateTask(t.id, { title: 'Entregar v2' });
  r = await gcal.syncTasksToCalendar();
  assert.equal(r.created, 1);
  assert.equal(g.events.size, 1);
  // concluída: remove
  updateTask(t.id, { completed: true });
  r = await gcal.syncTasksToCalendar();
  assert.equal(r.deleted, 1);
  assert.equal(g.events.size, 0);
  // desligado: pula
  setSettings({ gcal_push: '0' });
  assert.equal((await gcal.syncTasksToCalendar()).skipped, true);
  assert.equal(gcal.getStatus().mapped, 0);
});

test('leitura de compromissos ignora os eventos do próprio Organiza e divide os de vários dias', async () => {
  const g = fakeGoogle();
  gcal.saveCredentials(JSON.stringify(CREDS));
  setSettings({ gcal_calendar_id: 'eu@gmail.com', gcal_pull: '1' });
  g.events.set('a', { id: 'a', summary: 'Reunião', start: { dateTime: '2026-10-06T14:00:00-03:00' }, end: { dateTime: '2026-10-06T15:30:00-03:00' }, htmlLink: 'https://g/a' });
  g.events.set('b', { id: 'b', summary: 'Viagem', start: { date: '2026-10-07' }, end: { date: '2026-10-09' } });
  g.events.set('c', { id: 'c', summary: 'Do Organiza', start: { date: '2026-10-06' }, end: { date: '2026-10-07' }, extendedProperties: { private: { organizaTaskId: '1' } } });
  g.events.set('d', { id: 'd', summary: 'Cancelado', status: 'cancelled', start: { date: '2026-10-06' }, end: { date: '2026-10-07' } });
  const evs = await gcal.fetchEvents('2026-10-05', '2026-10-11');
  const titles = evs.map((e) => `${e.date} ${e.title}${e.all_day ? '' : ' ' + e.time}`);
  assert.deepEqual(titles, ['2026-10-06 Reunião 14:00', '2026-10-07 Viagem', '2026-10-08 Viagem']);
  assert.equal(evs[0].end_time, '15:30');
  assert.equal(evs[0].link, 'https://g/a');
  // cache: segunda chamada não consulta de novo
  const before = g.calls.length;
  await gcal.fetchEvents('2026-10-05', '2026-10-11');
  assert.equal(g.calls.length, before);
});

test('teste de conexão exige ID da agenda', async () => {
  gcal.saveCredentials(JSON.stringify(CREDS));
  setSettings({ gcal_calendar_id: '' });
  await assert.rejects(() => gcal.testConnection(), /ID da agenda/);
  fakeGoogle();
  setSettings({ gcal_calendar_id: 'eu@gmail.com' });
  const r = await gcal.testConnection();
  assert.equal(r.summary, 'Minha agenda');
});
