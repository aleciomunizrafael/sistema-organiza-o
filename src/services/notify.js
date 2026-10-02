import webpush from 'web-push';
import { getDb, getSettings, getState, setState, nowIso } from '../db/database.js';
import * as wa from '../whatsapp/client.js';

/**
 * Notificações: mensagem no próprio WhatsApp (pelo bot) e notificação do app
 * (Web Push) nos aparelhos onde o usuário ativou.
 */

let log = { info() {}, warn() {}, error() {} };
export function setLogger(l) { log = l; }

// ---------- Web Push ----------

export function vapidKeys() {
  let pub = getState('vapid_public');
  let priv = getState('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    pub = k.publicKey; priv = k.privateKey;
    setState('vapid_public', pub);
    setState('vapid_private', priv);
  }
  return { publicKey: pub, privateKey: priv };
}

function configureWebPush() {
  const { publicKey, privateKey } = vapidKeys();
  webpush.setVapidDetails('mailto:organiza@example.com', publicKey, privateKey);
}

export function saveSubscription(sub, userAgent) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Inscrição inválida');
  getDb().prepare(`INSERT INTO push_subscriptions (endpoint, subscription, user_agent, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription, failures = 0`)
    .run(sub.endpoint, JSON.stringify(sub), String(userAgent || '').slice(0, 200), nowIso());
}

export function removeSubscription(endpoint) {
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function countSubscriptions() {
  return Number(getDb().prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n);
}

async function sendPush(payload) {
  const db = getDb();
  const subs = db.prepare('SELECT endpoint, subscription FROM push_subscriptions').all();
  if (!subs.length) return 0;
  configureWebPush();
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.subscription), JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = e.statusCode;
      if (code === 404 || code === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint); // aparelho cancelou
      } else {
        db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(s.endpoint);
        log.warn({ code, err: e.message }, 'falha ao enviar notificação push');
      }
    }
  }
  return sent;
}

// ---------- envio combinado ----------

/**
 * Envia por todos os canais ativos. Retorna { whatsapp: bool, push: n }.
 * `text` é a mensagem do WhatsApp; `title`/`body` a notificação do app.
 */
export async function notify({ title, body, text, url = '/' }) {
  const settings = getSettings();
  const result = { whatsapp: false, push: 0, errors: [] };
  if (settings.notify_whatsapp === '1') {
    try { await wa.sendToSelf(text || `${title}\n${body || ''}`.trim()); result.whatsapp = true; }
    catch (e) { result.errors.push(`WhatsApp: ${e.message}`); }
  }
  if (settings.notify_push === '1') {
    try { result.push = await sendPush({ title, body: body || '', url }); }
    catch (e) { result.errors.push(`Push: ${e.message}`); }
  }
  return result;
}

const fmtDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; };

export function reminderMessage(task) {
  const extra = [];
  if (task.due_date) extra.push(`prazo ${fmtDate(task.due_date)}`);
  if (task.priority) extra.push('prioridade alta');
  if (task.trigger_text) extra.push(task.trigger_text);
  const details = extra.length ? ` (${extra.join(', ')})` : '';
  return {
    title: `Lembrete: ${task.title}`,
    body: (task.notes ? task.notes.split('\n')[0] : '') + (details ? (task.notes ? ' · ' : '') + details.slice(2, -1) : ''),
    text: `⏰ Lembrete: ${task.title}${details}${task.notes ? `\n${task.notes}` : ''}`,
    url: '/#today',
  };
}

export function digestMessage({ today, overdue, scheduledToday }) {
  const lines = [];
  const n = today.length;
  lines.push(`☀️ Bom dia! ${n ? `Você tem ${n} tarefa${n > 1 ? 's' : ''} para hoje.` : 'Nada pendente para hoje.'}`);
  if (overdue.length) {
    lines.push('', `⚠️ Atrasadas (${overdue.length}):`);
    for (const t of overdue) lines.push(`• ${t.title} (venceu ${fmtDate(t.due_date)})`);
  }
  const rest = today.filter((t) => !overdue.includes(t));
  if (rest.length) {
    lines.push('', '📋 Hoje:');
    for (const t of rest) lines.push(`• ${t.priority ? '! ' : ''}${t.title}${t.due_date ? ` (até ${fmtDate(t.due_date)})` : ''}`);
  }
  if (scheduledToday.length) {
    lines.push('', '📅 Entram hoje na lista:');
    for (const t of scheduledToday) lines.push(`• ${t.title}`);
  }
  const text = lines.join('\n');
  return {
    title: n ? `Hoje: ${n} tarefa${n > 1 ? 's' : ''}${overdue.length ? `, ${overdue.length} atrasada${overdue.length > 1 ? 's' : ''}` : ''}` : 'Nada pendente para hoje',
    body: rest.slice(0, 3).map((t) => t.title).join(' · '),
    text,
    url: '/#today',
  };
}
