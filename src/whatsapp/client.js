import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { getDb, getSettings, getState, setState, addNotice, nowIso } from '../db/database.js';
import { createTask } from '../services/tasks.js';
import { parseDemand, extractMessageText } from './parser.js';

const log = pino({ level: config.logLevel, transport: { target: 'pino/file', options: { destination: 1 } } }).child({ mod: 'whatsapp' });

const state = {
  status: 'disabled', // disabled | starting | qr | connecting | connected | disconnected | logged_out | error
  qr: null,           // data URL do QR code
  me: null,           // { id, name }
  connectedAt: null,
  lastError: null,
  groups: [],         // [{ jid, subject, participants }]
  stats: { received: 0, demands: 0, duplicates: 0, ignored: 0 },
};

let sock = null;
let baileys = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let stopping = false;

export function getStatus() {
  const settings = getSettings();
  return {
    enabled: config.waEnabled,
    ...state,
    group: state.groups.find((g) => g.jid === settings.wa_group_jid) || null,
    firstConnectedAt: getState('wa_first_connected_at'),
    lastSeenAt: getState('wa_last_seen_at'),
  };
}

export function listGroups() {
  return state.groups;
}

async function loadBaileys() {
  if (!baileys) baileys = await import('@whiskeysockets/baileys');
  return baileys;
}

export async function start() {
  if (!config.waEnabled) {
    state.status = 'disabled';
    return;
  }
  stopping = false;
  await connect();
}

export async function stop() {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  try { sock?.end(undefined); } catch { /* ignore */ }
  sock = null;
}

/** Encerra a sessão no WhatsApp e apaga as credenciais (exige novo QR). */
export async function logout() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  try { await sock?.logout(); } catch { /* ignore */ }
  sock = null;
  fs.rmSync(config.waAuthDir, { recursive: true, force: true });
  state.status = 'logged_out';
  state.qr = null;
  state.me = null;
  state.groups = [];
}

/** Força reconexão (ou novo pareamento se estiver deslogado). */
export async function reconnect() {
  clearTimeout(reconnectTimer);
  try { sock?.end(undefined); } catch { /* ignore */ }
  sock = null;
  reconnectAttempts = 0;
  await connect();
}

async function connect() {
  const {
    default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, DisconnectReason, Browsers,
  } = await loadBaileys();

  state.status = 'starting';
  state.lastError = null;
  fs.mkdirSync(config.waAuthDir, { recursive: true });

  const { state: authState, saveCreds } = await useMultiFileAuthState(config.waAuthDir);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (e) {
    log.warn({ err: e.message }, 'não foi possível buscar a versão mais recente; usando a padrão');
  }

  const silent = pino({ level: 'silent' });
  sock = makeWASocket({
    version,
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, silent) },
    logger: silent,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,   // não tira as notificações do celular
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = u;

    if (qr) {
      state.status = 'qr';
      try { state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch { state.qr = null; }
      log.info('QR code gerado; escaneie pela interface web');
    }

    if (connection === 'connecting') state.status = 'connecting';

    if (connection === 'open') {
      reconnectAttempts = 0;
      state.status = 'connected';
      state.qr = null;
      state.connectedAt = nowIso();
      const id = sock.user?.id || '';
      state.me = { id: id.split(':')[0].split('@')[0], name: sock.user?.name || '' };
      log.info({ me: state.me }, 'conectado ao WhatsApp');

      if (!getState('wa_first_connected_at')) setState('wa_first_connected_at', String(Date.now()));
      checkOfflineGap();
      startHeartbeat();
      refreshGroups().catch((e) => log.warn({ err: e.message }, 'falha ao listar grupos'));
    }

    if (receivedPendingNotifications) {
      log.info('mensagens pendentes do período offline foram recebidas');
    }

    if (connection === 'close') {
      clearInterval(heartbeatTimer);
      setState('wa_last_seen_at', String(Date.now()));
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || '';
      state.lastError = code ? `${code} ${msg}`.trim() : msg || null;

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        log.warn('sessão encerrada no celular; é preciso escanear o QR novamente');
        fs.rmSync(config.waAuthDir, { recursive: true, force: true });
        state.status = 'logged_out';
        state.me = null;
        addNotice('whatsapp', 'A sessão do WhatsApp foi encerrada. Abra Configurações e escaneie o QR code novamente.');
        return;
      }

      if (stopping) { state.status = 'disconnected'; return; }

      state.status = 'disconnected';
      const delay = Math.min(60000, 2000 * 2 ** Math.min(reconnectAttempts, 5));
      reconnectAttempts++;
      log.warn({ code, msg, delay }, 'conexão fechada; reconectando');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect().catch((e) => {
        state.status = 'error';
        state.lastError = e.message;
        log.error({ err: e.message }, 'falha ao reconectar');
        reconnectTimer = setTimeout(() => connect().catch(() => {}), 30000);
      }), delay);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try { handleMessage(msg); } catch (e) { log.error({ err: e.message }, 'erro ao processar mensagem'); }
    }
  });

  sock.ev.on('groups.upsert', () => refreshGroups().catch(() => {}));
  sock.ev.on('groups.update', () => refreshGroups().catch(() => {}));
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  setState('wa_last_seen_at', String(Date.now()));
  heartbeatTimer = setInterval(() => setState('wa_last_seen_at', String(Date.now())), 60_000);
}

/**
 * Se o bot ficou fora do ar por mais tempo que o configurado, registra um aviso.
 * As mensagens do período normalmente chegam sozinhas ao reconectar; o aviso é
 * uma rede de segurança para você conferir o grupo.
 */
function checkOfflineGap() {
  const last = Number(getState('wa_last_seen_at') || 0);
  if (!last) return;
  const hours = Number(getSettings().wa_offline_alert_hours || 0);
  if (!hours) return;
  const gapMs = Date.now() - last;
  if (gapMs < hours * 3600_000) return;
  const fmt = (ms) => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  addNotice('offline', `O bot do WhatsApp ficou offline de ${fmt(last)} até ${fmt(Date.now())}. `
    + 'As mensagens desse período devem ter sido recebidas automaticamente, mas vale conferir o grupo.');
  log.warn({ gapHours: (gapMs / 3600_000).toFixed(1) }, 'período offline detectado');
}

async function refreshGroups() {
  if (!sock) return;
  const groups = await sock.groupFetchAllParticipating();
  state.groups = Object.values(groups)
    .map((g) => ({ jid: g.id, subject: g.subject || g.id, participants: g.participants?.length || 0 }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));
}

function senderInfo(msg) {
  const raw = msg.key.participantPn || msg.key.participant || msg.participant || msg.key.remoteJid || '';
  const number = raw.split('@')[0].split(':')[0];
  const name = msg.pushName || '';
  return { number, name, label: name ? (number ? `${name} (${number})` : name) : number };
}

function tsOf(msg) {
  const t = msg.messageTimestamp;
  if (t == null) return Date.now();
  const n = typeof t === 'number' ? t : typeof t === 'object' && typeof t.toNumber === 'function' ? t.toNumber() : Number(t);
  return n * 1000;
}

function handleMessage(msg) {
  if (!msg?.message || !msg.key?.id) return;
  const settings = getSettings();
  const chat = msg.key.remoteJid || '';
  const isGroup = chat.endsWith('@g.us');

  state.stats.received++;

  // Só processa o grupo configurado (ou o próprio chat "você" como caixa de entrada pessoal)
  const isSelfChat = !isGroup && state.me && chat.startsWith(state.me.id) && msg.key.fromMe;
  if (!settings.wa_group_jid && !isSelfChat) { state.stats.ignored++; return; }
  if (settings.wa_group_jid && chat !== settings.wa_group_jid && !isSelfChat) { state.stats.ignored++; return; }

  if (msg.key.fromMe && settings.wa_accept_own !== '1' && !isSelfChat) { state.stats.ignored++; return; }

  const text = extractMessageText(msg.message);
  if (!text) { state.stats.ignored++; return; }

  const tsMs = tsOf(msg);
  const first = Number(getState('wa_first_connected_at') || 0);
  // Ignora mensagens anteriores ao primeiro pareamento (com tolerância de 10 min)
  if (first && tsMs < first - 10 * 60_000) { state.stats.ignored++; return; }

  const sender = senderInfo(msg);
  const allowed = (settings.wa_allowed_senders || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !msg.key.fromMe) {
    const ok = allowed.some((a) => {
      const digits = a.replace(/\D/g, '');
      if (digits && /^[\d\s()+\-]+$/.test(a)) return sender.number.endsWith(digits);
      return sender.name.toLowerCase().includes(a);
    });
    if (!ok) { state.stats.ignored++; return; }
  }

  const demand = parseDemand(text, settings.wa_marker);
  if (!demand) { state.stats.ignored++; return; }

  const db = getDb();
  if (db.prepare('SELECT 1 FROM wa_messages WHERE message_id = ?').get(msg.key.id)) {
    state.stats.duplicates++;
    return;
  }

  const tsIso = new Date(tsMs).toISOString();
  let task;
  try {
    task = createTask({
      ...demand,
      source: 'whatsapp',
      source_sender: sender.label,
      source_text: text,
      source_message_id: msg.key.id,
      source_timestamp: tsIso,
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) { state.stats.duplicates++; return; }
    throw e;
  }

  db.prepare('INSERT OR IGNORE INTO wa_messages (message_id, chat_jid, sender, text, message_ts, task_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(msg.key.id, chat, sender.label, text, tsIso, task.id);
  state.stats.demands++;
  log.info({ id: task.id, title: task.title, from: sender.label }, 'demanda criada a partir do WhatsApp');

  if (settings.wa_reply_enabled === '1' && sock) {
    const extra = [];
    if (task.due_date) extra.push(`prazo ${fmtDate(task.due_date)}`);
    if (task.recurrence_label) extra.push(task.recurrence_label.toLowerCase());
    if (task.priority) extra.push('prioridade alta');
    const template = settings.wa_reply_text || '✅ Anotado: {titulo}';
    const details = extra.length ? `(${extra.join(', ')})` : '';
    let reply = template.replace('{titulo}', task.title);
    if (template.includes('{detalhes}')) reply = reply.replace('{detalhes}', details);
    else if (details) reply += ' ' + details;
    sock.sendMessage(chat, { text: reply.trim() }, { quoted: msg })
      .catch((e) => log.warn({ err: e.message }, 'não foi possível responder no grupo'));
  }
}

function fmtDate(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

export const __test = { handleMessage, state, setSock: (s) => { sock = s; } };
