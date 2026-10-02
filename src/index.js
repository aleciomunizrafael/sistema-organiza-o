import { config } from './config.js';
import express from 'express';
import pino from 'pino';
import { getDb } from './db/database.js';
import { apiRouter } from './routes/api.js';
import { startScheduler } from './services/scheduler.js';
import * as wa from './whatsapp/client.js';
import { calendarToken, buildCalendar } from './services/ical.js';
import { authMiddleware, authEnabled, checkPassword, createSession, destroySession, cookieHeader, tooManyFails, recordFail, clearFails } from './auth.js';

const log = pino({ level: config.logLevel, transport: { target: 'pino/file', options: { destination: 1 } } });

getDb();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

app.set('trust proxy', 'loopback'); // atrás do Caddy: req.secure e req.ip corretos

// Bloqueia POST/PUT/PATCH/DELETE vindos de outra origem (CSRF). Requisições sem Origin (scripts, curl) passam.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Origem não permitida' });
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* "null" ou inválido: rejeita */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Origem não permitida' });
  }
  next();
});


// Autenticação por sessão (APP_PASSWORD no .env). Sem senha configurada, tudo é aberto.
app.get('/api/auth/status', (_req, res) => res.json({ enabled: authEnabled() }));
app.post('/api/login', (req, res) => {
  if (!authEnabled()) return res.json({ ok: true });
  const ip = req.ip || 'desconhecido';
  if (tooManyFails(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { user, password } = req.body || {};
  if (!checkPassword(String(user || ''), String(password || ''))) {
    recordFail(ip);
    log.warn({ ip }, 'tentativa de login inválida');
    return res.status(401).json({ error: 'Usuário ou senha incorretos' });
  }
  clearFails(ip);
  const token = createSession(req);
  res.set('Set-Cookie', cookieHeader(req, token));
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  destroySession(req);
  res.set('Set-Cookie', cookieHeader(req, '', { clear: true }));
  res.json({ ok: true });
});
// Calendário para assinar (Google Agenda etc.): protegido pelo token no endereço
app.get('/calendar/:token.ics', (req, res) => {
  if (req.params.token !== calendarToken()) return res.status(404).send('Não encontrado');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(buildCalendar({ baseUrl: `${proto}://${req.headers.host}` }));
});

app.use(authMiddleware);

app.use('/api', apiRouter());
app.use(express.static(config.publicDir, { extensions: ['html'] }));

// Erros da API em JSON
app.use((err, _req, res, _next) => {
  log.error({ err: err.message }, 'erro na requisição');
  res.status(err.status || 400).json({ error: err.message || 'Erro' });
});

app.listen(config.port, config.host, () => {
  log.info({ port: config.port, host: config.host, tz: config.tz, data: config.dataDir }, 'Organiza rodando');
  log.info(`Abra http://localhost:${config.port}`);
});

startScheduler(log);

wa.start().catch((e) => log.error({ err: e.message }, 'falha ao iniciar WhatsApp'));

process.on('unhandledRejection', (e) => log.error({ err: e?.message || String(e) }, 'rejeição não tratada'));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log.info('encerrando');
    await wa.stop();
    process.exit(0);
  });
}
