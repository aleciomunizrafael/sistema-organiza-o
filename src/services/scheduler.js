import cron from 'node-cron';
import { materializeAll, dueReminders, markReminded, listTasks } from './tasks.js';
import { getSettings, getState, setState } from '../db/database.js';
import { today as todayYmd } from './dates.js';
import { notify, reminderMessage, digestMessage, setLogger } from './notify.js';

function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Tarefas agendadas do servidor:
 * - ocorrências recorrentes (ao iniciar, 00:05 e de hora em hora);
 * - lembretes com data e hora (a cada minuto);
 * - resumo diário no horário configurado (a cada minuto, confere o horário).
 */
export function startScheduler(log) {
  setLogger(log);
  const run = (why) => {
    try {
      const n = materializeAll();
      if (n) log.info({ created: n, why }, 'ocorrências recorrentes criadas');
    } catch (e) {
      log.error({ err: e.message }, 'erro ao materializar recorrências');
    }
  };
  run('startup');
  cron.schedule('5 0 * * *', () => run('daily'));
  cron.schedule('0 * * * *', () => run('hourly'));

  cron.schedule('* * * * *', async () => {
    await sendDueReminders(log).catch((e) => log.error({ err: e.message }, 'erro nos lembretes'));
    await sendDigestIfTime(log).catch((e) => log.error({ err: e.message }, 'erro no resumo diário'));
  });
}

export async function sendDueReminders(log) {
  for (const task of dueReminders(nowLocal())) {
    const r = await notify(reminderMessage(task));
    markReminded(task.id);
    log.info({ id: task.id, title: task.title, ...r }, 'lembrete enviado');
  }
}

export async function sendDigestIfTime(log) {
  const s = getSettings();
  const time = (s.digest_time || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time)) return;
  const now = nowLocal();
  const today = todayYmd();
  if (now.slice(11) !== time) return;
  if (getState('digest_sent_on') === today) return;
  const days = (s.digest_days || '1,2,3,4,5').split(',').map(Number);
  if (!days.includes(new Date().getDay())) return;
  setState('digest_sent_on', today);
  const r = await notify(buildDigest());
  log.info(r, 'resumo diário enviado');
}

export function buildDigest(today = todayYmd()) {
  const todayList = listTasks('today', today);
  const overdue = todayList.filter((t) => t.due_date && t.due_date < today);
  const scheduledToday = todayList.filter((t) => t.start_date === today && !t.template_id);
  return digestMessage({ today: todayList, overdue, scheduledToday });
}
