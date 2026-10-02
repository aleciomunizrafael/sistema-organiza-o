import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { getDb, nowIso } from './db/database.js';

/**
 * Autenticação por sessão em cookie (funciona no app instalado no celular, onde a
 * janela de "autenticação básica" do navegador não aparece). A autenticação básica
 * continua aceita para scripts e atalhos.
 */

const COOKIE = 'organiza_session';
const SESSION_DAYS = 180;
const MAX_FAILS = 10;           // tentativas erradas por IP...
const FAIL_WINDOW_MS = 15 * 60_000; // ...em 15 minutos

const fails = new Map(); // ip -> { count, first }

export function authEnabled() {
  return Boolean(config.appPassword);
}

function hash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPassword(user, password) {
  return safeEqual(user, config.appUser) && safeEqual(password, config.appPassword);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(req) {
  const token = randomBytes(32).toString('base64url');
  getDb().prepare('INSERT INTO sessions (token_hash, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), String(req.headers['user-agent'] || '').slice(0, 200), nowIso(), nowIso());
  return token;
}

export function destroySession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}

function sessionValid(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const db = getDb();
  const row = db.prepare('SELECT token_hash, created_at FROM sessions WHERE token_hash = ?').get(hash(token));
  if (!row) return false;
  const ageDays = (Date.now() - new Date(row.created_at).getTime()) / 86400000;
  if (ageDays > SESSION_DAYS) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash); return false; }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), row.token_hash);
  return true;
}

function basicValid(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return checkPassword(user, rest.join(':'));
}

export function cookieHeader(req, token, { clear = false } = {}) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) { fails.delete(ip); return false; }
  return f.count >= MAX_FAILS;
}

export function recordFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

export function clearFails(ip) {
  fails.delete(ip);
}

/** Caminhos liberados sem login (tela de login e seus recursos). */
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/styles.css', '/manifest.json', '/icons/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/api/login', '/api/auth/status']);

export function authMiddleware(req, res, next) {
  if (!authEnabled()) return next();
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/calendar/')) return next();
  if (sessionValid(req) || basicValid(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Faça login para continuar', login: true });
  // Páginas: manda para a tela de login (o service worker também não é servido sem login)
  res.redirect('/login');
}
