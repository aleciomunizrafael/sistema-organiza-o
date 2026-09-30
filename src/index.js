import { config } from './config.js';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import pino from 'pino';
import { getDb } from './db/database.js';
import { apiRouter } from './routes/api.js';
import { startScheduler } from './services/scheduler.js';
import * as wa from './whatsapp/client.js';

const log = pino({ level: config.logLevel, transport: { target: 'pino/file', options: { destination: 1 } } });

getDb();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// Autenticação simples opcional (APP_PASSWORD no .env)
if (config.appPassword) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      const given = Buffer.from(`${user}:${rest.join(':')}`);
      const expected = Buffer.from(`${config.appUser}:${config.appPassword}`);
      if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Organiza", charset="UTF-8"');
    res.status(401).send('Autenticação necessária');
  });
}

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
