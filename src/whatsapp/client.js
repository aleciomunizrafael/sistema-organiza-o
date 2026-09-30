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
  status: 'disabled', // disabled | starting | qr | connecting | connected | disconnected | logged_out | conflict | error
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
let offlineWatchTimer = null;
let offlineNoticeGiven = false;
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
  startOfflineWatch();
  await connect();
}

export async function stop() {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearInterval(offlineWatchTimer);
  const s = sock;
  sock = null;
  state.status = 'disconnected';
  try { s?.end(undefined); } catch { /* ignore */ }
}

/** Encerra a sessão no WhatsApp e apaga as credenciais (exige novo QR). */
export async function logout() {
  if (!config.waEnabled) throw new Error('WhatsApp desativado (WA_ENABLED=false)');
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  const s = sock;
  sock = null; // eventos tardios desse socket passam a ser ignorados (s !== sock)
  try {
    await s?.logout();
  } catch {
    // Com o WebSocket ainda fechando/conectando o Baileys lança antes de encerrar; encerra manualmente
    try { s?.end(Object.assign(new Error('Intentional Logout'), { output: { statusCode: 401 } })); } catch { /* ignore */ }
  }
  fs.rmSync(config.waAuthDir, { recursive: true, force: true });
  state.status = 'logged_out';
  state.qr = null;
  state.me = null;
  state.groups = [];
}

/** Força reconexão (ou novo pareamento se estiver deslogado). */
export async function reconnect() {
  if (!config.waEnabled) throw new Error('WhatsApp desativado (WA_ENABLED=false)');
  stopping = false;
  reconnectAttempts = 0;
  await connect();
}

function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect().catch((e) => {
    state.status = 'error';
    state.lastError = e.message;
    log.error({ err: e.message }, 'falha ao reconectar');
    scheduleReconnect(30000);
  }), delay);
}

async function connect() {
  const {
    default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore, DisconnectReason, Browsers,
  } = await loadBaileys();

  // Garante um único socket vivo: encerra o anterior e cancela reconexões pendentes
  clearTimeout(reconnectTimer);
  const prev = sock;
  sock = null;
  try { prev?.end(undefined); } catch { /* ignore */ }

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
  const s = makeWASocket({
    version,
    auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, silent) },
    logger: silent,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,   // não tira as notificações do celular
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });
  sock = s;
  let opened = false; // este socket chegou a abrir?

  s.ev.on('creds.update', saveCreds);

  s.ev.on('connection.update', async (u) => {
    if (s !== sock) return; // socket substituído por connect()/reconnect()/stop()/logout(): ignora eventos tardios
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = u;

    if (qr) {
      state.status = 'qr';
      try { state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch { state.qr = null; }
      log.info('QR code gerado; escaneie pela interface web');
    }

    if (connection === 'connecting') state.status = 'connecting';

    if (connection === 'open') {
      opened = true;
      reconnectAttempts = 0;
      offlineNoticeGiven = false;
      state.status = 'connected';
      state.qr = null;
      state.connectedAt = nowIso();
      const id = s.user?.id || '';
      state.me = { id: id.split(':')[0].split('@')[0], name: s.user?.name || '' };
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
      // Só conta como "visto" se esta conexão chegou a abrir (tentativas falhas não renovam o carimbo)
      if (opened) setState('wa_last_seen_at', String(Date.now()));
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || '';
      state.lastError = code ? `${code} ${msg}`.trim() : msg || null;

      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
        log.warn('sessão encerrada no celular; é preciso escanear o QR novamente');
        fs.rmSync(config.waAuthDir, { recursive: true, force: true });
        sock = null;
        state.status = 'logged_out';
        state.me = null;
        addNotice('whatsapp', 'A sessão do WhatsApp foi encerrada. Abra Configurações e escaneie o QR code novamente.');
        return;
      }

      if (code === DisconnectReason.connectionReplaced) {
        // Outra máquina abriu a mesma sessão (mesma pasta wa-auth). Não briga: fica parado até o usuário decidir.
        log.warn('conexão substituída por outro dispositivo com a mesma sessão; reconexão automática suspensa');
        sock = null;
        state.status = 'conflict';
        addNotice('whatsapp', 'Outra máquina conectou usando a mesma sessão do WhatsApp deste bot (mesma pasta data/wa-auth). '
          + 'Desligue o bot na outra máquina e clique em "Reconectar" nas Configurações, ou desconecte a sessão aqui e pareie de novo.');
        return;
      }

      if (stopping) { state.status = 'disconnected'; return; }

      state.status = 'disconnected';
      const delay = Math.min(60000, 2000 * 2 ** Math.min(reconnectAttempts, 5));
      reconnectAttempts++;
      log.warn({ code, msg, delay }, 'conexão fechada; reconectando');
      scheduleReconnect(delay);
    }
  });

  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (s !== sock) return;
    log.debug({ type, count: messages.length }, 'messages.upsert');
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      try { handleMessage(msg); } catch (e) { log.error({ err: e.message }, 'erro ao processar mensagem'); }
    }
  });

  // groupFetchAllParticipating() emite 'groups.update' por conta própria; atualiza pelo payload, sem nova consulta
  s.ev.on('groups.upsert', (groups) => { if (s === sock) mergeGroups(groups); });
  s.ev.on('groups.update', (updates) => { if (s === sock) mergeGroups(updates); });
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  setState('wa_last_seen_at', String(Date.now()));
  heartbeatTimer = setInterval(() => setState('wa_last_seen_at', String(Date.now())), 60_000);
}

const fmtWhen = (ms) => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

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
  addNotice('offline', `O bot do WhatsApp ficou offline de ${fmtWhen(last)} até ${fmtWhen(Date.now())}. `
    + 'As mensagens desse período devem ter sido recebidas automaticamente, mas vale conferir o grupo.');
  log.warn({ gapHours: (gapMs / 3600_000).toFixed(1) }, 'período offline detectado');
}

/** Enquanto o bot está caído (sem reconectar), avisa uma vez ao passar do limite configurado. */
function checkStillOffline() {
  if (state.status === 'connected' || state.status === 'disabled' || offlineNoticeGiven) return;
  const last = Number(getState('wa_last_seen_at') || 0);
  const hours = Number(getSettings().wa_offline_alert_hours || 0);
  if (!last || !hours || Date.now() - last < hours * 3600_000) return;
  offlineNoticeGiven = true;
  const why = { qr: 'aguardando leitura do QR code', logged_out: 'sessão encerrada', conflict: 'sessão em uso por outra máquina' }[state.status]
    || `situação: ${state.status}`;
  addNotice('offline', `O bot do WhatsApp está desconectado desde ${fmtWhen(last)} (${why}). Abra Configurações para verificar.`);
}

function startOfflineWatch() {
  clearInterval(offlineWatchTimer);
  offlineWatchTimer = setInterval(checkStillOffline, 5 * 60_000);
}

function mergeGroups(list) {
  for (const g of list || []) {
    if (!g?.id) continue;
    const cur = state.groups.find((x) => x.jid === g.id);
    if (cur) {
      if (g.subject) cur.subject = g.subject;
      if (Array.isArray(g.participants)) cur.participants = g.participants.length;
    } else {
      state.groups.push({ jid: g.id, subject: g.subject || g.id, participants: g.participants?.length || 0 });
    }
  }
  state.groups.sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));
}

let refreshingGroups = false;
async function refreshGroups() {
  if (!sock || refreshingGroups) return;
  refreshingGroups = true;
  try {
    const groups = await sock.groupFetchAllParticipating();
    state.groups = Object.values(groups)
      .map((g) => ({ jid: g.id, subject: g.subject || g.id, participants: g.participants?.length || 0 }))
      .sort((a, b) => a.subject.localeCompare(b.subject, 'pt-BR'));
    log.info({ groups: state.groups.length, monitorado: getSettings().wa_group_jid || '(nenhum)' }, 'grupos carregados');
  } finally {
    refreshingGroups = false;
  }
}

/** Nome e número do remetente. Em grupos no modo LID o telefone vem em participantAlt. */
function senderInfo(msg) {
  const k = msg.key || {};
  const cands = [k.participantAlt, k.participant, msg.participant, k.remoteJidAlt, k.remoteJid].filter(Boolean);
  const raw = cands.find((j) => j.endsWith('@s.whatsapp.net')) || cands[0] || '';
  const number = raw.split('@')[0].split(':')[0];
  const name = msg.pushName || '';
  return { number, name, label: name ? (number ? `${name} (${number})` : name) : number };
}

function tsOf(msg) {
  const t = msg.messageTimestamp;
  let n;
  if (t == null) n = NaN;
  else if (typeof t === 'number') n = t;
  else if (typeof t === 'bigint') n = Number(t);
  else if (typeof t === 'object' && typeof t.toNumber === 'function') n = t.toNumber();
  else if (typeof t === 'object' && typeof t.low === 'number') n = (t.high >>> 0) * 4294967296 + (t.low >>> 0);
  else n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n * 1000;
}

function handleMessage(msg) {
  if (!msg?.key?.id) return;
  if (!msg.message) {
    log.debug({ id: msg.key.id, chat: msg.key.remoteJid, stub: msg.messageStubType }, 'mensagem sem conteúdo (não decifrada ou evento de sistema)');
    return;
  }
  const settings = getSettings();
  const chat = msg.key.remoteJid || '';
  const isGroup = chat.endsWith('@g.us');
  const text = extractMessageText(msg.message);
  const isTargetChat = Boolean(settings.wa_group_jid) && chat === settings.wa_group_jid;

  state.stats.received++;

  // Mensagens do grupo configurado aparecem no log em nível info; as demais em debug
  const diag = { id: msg.key.id, chat, fromMe: Boolean(msg.key.fromMe), from: msg.pushName || '', text: text.slice(0, 80) };
  const ignore = (reason) => {
    state.stats.ignored++;
    log[isTargetChat ? 'info' : 'debug']({ ...diag, reason }, 'mensagem ignorada');
  };

  // Só processa o grupo configurado (ou o próprio chat "você" como caixa de entrada pessoal)
  const isSelfChat = !isGroup && state.me && chat.startsWith(state.me.id) && msg.key.fromMe;
  if (!settings.wa_group_jid && !isSelfChat) return ignore('nenhum grupo configurado em Configurações');
  if (settings.wa_group_jid && !isTargetChat && !isSelfChat) return ignore('não é o grupo monitorado');

  if (msg.key.fromMe && settings.wa_accept_own !== '1' && !isSelfChat) return ignore('mensagem própria (opção desativada)');

  if (!text) return ignore('mensagem sem texto (mídia, figurinha, áudio...)');

  const tsMs = tsOf(msg);
  const first = Number(getState('wa_first_connected_at') || 0);
  // Ignora mensagens anteriores ao primeiro pareamento (com tolerância de 10 min)
  if (first && tsMs < first - 10 * 60_000) return ignore('anterior ao primeiro pareamento');

  const sender = senderInfo(msg);
  const allowed = (settings.wa_allowed_senders || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !msg.key.fromMe) {
    const ok = allowed.some((a) => {
      const digits = a.replace(/\D/g, '');
      if (digits && /^[\d\s()+\-]+$/.test(a)) return sender.number.endsWith(digits);
      return sender.name.toLowerCase().includes(a);
    });
    if (!ok) return ignore(`remetente "${sender.label}" não está na lista de permitidos`);
  }

  const demand = parseDemand(text, settings.wa_marker);
  if (!demand) return ignore(`sem o marcador "${settings.wa_marker}"`);
  log.info(diag, 'demanda reconhecida');

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
