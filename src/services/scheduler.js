import cron from 'node-cron';
import { materializeAll } from './tasks.js';

/**
 * Cria as ocorrências das tarefas recorrentes. Roda ao iniciar, todo dia logo
 * após a meia-noite e de hora em hora (garante que nada fique para trás se o
 * computador estiver desligado à meia-noite).
 */
export function startScheduler(log) {
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
}
