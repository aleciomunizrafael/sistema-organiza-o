import { getDb, nowIso } from '../db/database.js';
import { today as todayYmd, isValidYmd, addDays } from './dates.js';
import { normalizeRule, nextOccurrence, lastOccurrenceUpTo, describeRule, matches } from './recurrence.js';

function row(r) {
  if (!r) return null;
  const rule = r.recurrence ? JSON.parse(r.recurrence) : null;
  return {
    ...r,
    priority: Number(r.priority),
    someday: Boolean(r.someday),
    is_template: Boolean(r.is_template),
    recurrence: rule,
    recurrence_label: rule ? describeRule(rule) : '',
  };
}

function cleanDate(v) {
  if (v == null || v === '') return null;
  if (!isValidYmd(v)) throw new Error(`Data inválida: ${v}`);
  return v;
}

/** Booleano tolerante a formulários: aceita true/1/'1'/'true'/'on'; tudo o mais é falso. */
function toBool(v) {
  if (typeof v === 'string') return ['1', 'true', 'on', 'yes', 'sim'].includes(v.trim().toLowerCase());
  return v === true || v === 1;
}

function cleanTitle(v) {
  if (typeof v !== 'string') throw new Error('Título obrigatório');
  const t = v.trim();
  if (!t) throw new Error('Título obrigatório');
  return t;
}

/** 'YYYY-MM-DDTHH:MM' (hora local) ou null. */
function cleanDateTime(v) {
  if (v == null || v === '') return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m || !isValidYmd(m[1]) || +m[2] > 23 || +m[3] > 59) throw new Error(`Data e hora inválidas: ${v}`);
  return `${m[1]}T${m[2]}:${m[3]}`;
}

export const STATUSES = ['todo', 'doing', 'leticia'];

function cleanStatus(v) {
  if (v == null || v === '') return 'todo';
  if (!STATUSES.includes(v)) throw new Error(`Situação inválida: ${v}`);
  return v;
}

/** Próxima posição: no fim da lista, ou no topo para prioridade alta. */
function nextSortOrder(top = false) {
  const r = getDb().prepare(`SELECT ${top ? 'MIN' : 'MAX'}(sort_order) AS v FROM tasks`).get();
  const v = r?.v;
  if (v == null) return 1;
  return top ? v - 1 : v + 1;
}

function cleanText(v) {
  if (v == null) return '';
  if (typeof v !== 'string') throw new Error('Texto inválido');
  return v.trim();
}

export function getTask(id) {
  return row(getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

/**
 * Cria uma tarefa. Se `recurrence` for informada, cria um modelo recorrente e
 * materializa a primeira ocorrência quando ela já estiver no prazo.
 */
export function createTask(input) {
  const db = getDb();
  const title = cleanTitle(input.title);
  const notes = cleanText(input.notes);
  const priority = toBool(input.priority) ? 1 : 0;
  const someday = toBool(input.someday) ? 1 : 0;
  const trigger = cleanText(input.trigger_text) || null;
  const remindAt = cleanDateTime(input.remind_at);
  const rule = someday ? null : normalizeRule(input.recurrence);
  let startDate = someday ? null : cleanDate(input.start_date);
  let dueDate = someday ? null : cleanDate(input.due_date);
  const source = input.source || 'manual';

  if (rule) {
    // Modelo recorrente: âncora = start_date (ou hoje)
    if (!startDate) startDate = todayYmd();
    const r = db.prepare(`
      INSERT INTO tasks (title, notes, start_date, due_date, priority, source, source_sender, source_text,
                         source_message_id, source_timestamp, recurrence, is_template)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(title, notes, startDate, priority, source, input.source_sender ?? null, input.source_text ?? null,
      input.source_message_id ?? null, input.source_timestamp ?? null, JSON.stringify(rule));
    const id = Number(r.lastInsertRowid);
    ensureOccurrence(id, todayYmd());
    return getTask(id);
  }

  const r = db.prepare(`
    INSERT INTO tasks (title, notes, start_date, due_date, priority, someday, trigger_text, remind_at, status, sort_order,
                       source, source_sender, source_text, source_message_id, source_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, notes, startDate, dueDate, priority, someday, trigger, remindAt, someday ? 'todo' : cleanStatus(input.status),
    nextSortOrder(Boolean(priority)), source, input.source_sender ?? null, input.source_text ?? null,
    input.source_message_id ?? null, input.source_timestamp ?? null);
  return getTask(Number(r.lastInsertRowid));
}

export function updateTask(id, input) {
  const db = getDb();
  const current = getTask(id);
  if (!current) return null;

  const fields = [];
  const values = [];
  const set = (col, val) => { fields.push(`${col} = ?`); values.push(val); };

  if (input.title !== undefined) set('title', cleanTitle(input.title));
  if (input.notes !== undefined) set('notes', cleanText(input.notes));
  if (input.priority !== undefined) set('priority', toBool(input.priority) ? 1 : 0);
  if (input.trigger_text !== undefined) set('trigger_text', cleanText(input.trigger_text) || null);
  if (input.status !== undefined && !current.is_template) set('status', cleanStatus(input.status));
  if (input.remind_at !== undefined) {
    const r = cleanDateTime(input.remind_at);
    set('remind_at', r);
    if (r !== current.remind_at) set('reminded_at', null); // lembrete novo ou alterado volta a valer
  }

  const isOccurrence = Boolean(current.template_id);

  // "Sem data" (algum dia): sem datas nem recorrência. Ganhar uma data devolve a tarefa para "A fazer".
  let someday = current.someday;
  if (input.someday !== undefined && !current.is_template && !isOccurrence) {
    someday = toBool(input.someday);
    set('someday', someday ? 1 : 0);
  }
  if (someday) {
    if (current.start_date || current.due_date) { set('start_date', null); set('due_date', null); }
    if (input.someday === undefined && (cleanDate(input.start_date) || cleanDate(input.due_date))) {
      someday = false;
      set('someday', 0);
    }
  }

  // Recorrência: uma ocorrência nunca vira modelo (isso bloquearia o modelo original)
  const rule = input.recurrence !== undefined && !someday && !isOccurrence ? normalizeRule(input.recurrence) : undefined;
  const willBeTemplate = rule === undefined ? current.is_template : Boolean(rule);

  if (!someday) {
    if (input.start_date !== undefined) {
      let sd = cleanDate(input.start_date);
      if (!sd && willBeTemplate) sd = current.start_date || todayYmd(); // um modelo sempre tem âncora
      set('start_date', sd);
    } else if (willBeTemplate && !current.start_date) {
      set('start_date', todayYmd());
    }
    if (input.due_date !== undefined && !willBeTemplate) set('due_date', cleanDate(input.due_date));
  }

  if (input.completed !== undefined) {
    const completed = toBool(input.completed);
    if (!completed && isOccurrence && current.completed_at) {
      const other = db.prepare('SELECT id FROM tasks WHERE template_id = ? AND completed_at IS NULL AND id != ? LIMIT 1')
        .get(current.template_id, id);
      if (other) throw new Error('Já existe uma ocorrência aberta desta tarefa recorrente. Conclua ou exclua a outra antes de reabrir esta.');
    }
    set('completed_at', completed ? nowIso() : null);
  }

  if (rule !== undefined) {
    if (current.is_template) {
      if (rule) set('recurrence', JSON.stringify(rule));
      else {
        // Deixa de ser recorrente: vira tarefa comum aberta (ocorrências concluídas ficam no histórico)
        set('recurrence', null);
        set('is_template', 0);
        if (input.completed === undefined) set('completed_at', null); // "pausado" não vira "concluído"
        db.prepare('DELETE FROM tasks WHERE template_id = ? AND completed_at IS NULL').run(id);
        db.prepare('DELETE FROM skipped_occurrences WHERE template_id = ?').run(id);
      }
    } else if (rule) {
      set('recurrence', JSON.stringify(rule));
      set('is_template', 1);
      set('due_date', null);
    }
  }

  if (fields.length) {
    set('updated_at', nowIso());
    values.push(id);
    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const updated = getTask(id);

  // Propaga título/notas/prioridade do modelo para ocorrências abertas
  if (updated.is_template) {
    db.prepare('UPDATE tasks SET title = ?, notes = ?, priority = ? WHERE template_id = ? AND completed_at IS NULL')
      .run(updated.title, updated.notes, updated.priority, id);
    ensureOccurrence(id, todayYmd());
  }

  // Concluiu uma ocorrência: garante a próxima quando chegar a hora
  if (input.completed && updated.template_id) {
    ensureOccurrence(updated.template_id, todayYmd());
  }

  return updated;
}

export function deleteTask(id) {
  const db = getDb();
  const t = getTask(id);
  if (!t) return false;
  // Excluir uma ocorrência: registra a data como pulada para o agendador não recriá-la
  if (t.template_id && t.occurrence_date) {
    db.prepare('INSERT OR IGNORE INTO skipped_occurrences (template_id, occurrence_date) VALUES (?, ?)')
      .run(t.template_id, t.occurrence_date);
  }
  const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return r.changes > 0;
}

/** Última data já tratada de um modelo: materializada ou pulada (excluída pelo usuário). */
function lastHandledDate(templateId) {
  const db = getDb();
  const a = db.prepare('SELECT MAX(occurrence_date) AS d FROM tasks WHERE template_id = ?').get(templateId)?.d || null;
  const b = db.prepare('SELECT MAX(occurrence_date) AS d FROM skipped_occurrences WHERE template_id = ?').get(templateId)?.d || null;
  return a && b ? (a > b ? a : b) : (a || b);
}

/** Âncora da recorrência. Um modelo sem start_date recebe hoje como âncora (persistido). */
function anchorOf(tpl, today) {
  if (tpl.start_date) return tpl.start_date;
  getDb().prepare('UPDATE tasks SET start_date = ? WHERE id = ? AND start_date IS NULL').run(today, tpl.id);
  return today;
}

/**
 * Garante que um modelo recorrente tenha exatamente uma ocorrência aberta
 * quando sua data já chegou. Se várias datas passaram enquanto o sistema
 * estava parado, cria apenas a mais recente (não acumula atrasos).
 */
export function ensureOccurrence(templateId, today = todayYmd()) {
  const db = getDb();
  const tpl = getTask(templateId);
  if (!tpl || !tpl.is_template || !tpl.recurrence) return null;
  if (tpl.completed_at) return null; // modelo pausado

  const open = db.prepare('SELECT id FROM tasks WHERE template_id = ? AND completed_at IS NULL LIMIT 1').get(templateId);
  if (open) return null;

  const last = lastHandledDate(templateId);
  const anchor = anchorOf(tpl, today);

  // Candidata: última data <= hoje que ainda não foi materializada nem pulada
  let date = lastOccurrenceUpTo(tpl.recurrence, anchor, today);
  if (!date || (last && date <= last)) return null;

  const r = db.prepare(`
    INSERT OR IGNORE INTO tasks (title, notes, start_date, due_date, priority, source, source_sender,
                                 template_id, occurrence_date, sort_order)
    VALUES (?, ?, ?, ?, ?, 'recurrence', ?, ?, ?, ?)
  `).run(tpl.title, tpl.notes, date, date, tpl.priority, tpl.source_sender, templateId, date, nextSortOrder());
  return r.changes ? getTask(Number(r.lastInsertRowid)) : null;
}

/** Roda para todos os modelos. Chamado na inicialização e pelo agendador. */
export function materializeAll(today = todayYmd()) {
  const ids = getDb().prepare('SELECT id FROM tasks WHERE is_template = 1 AND completed_at IS NULL').all();
  let created = 0;
  for (const { id } of ids) if (ensureOccurrence(id, today)) created++;
  return created;
}

/** Próxima data de um modelo a partir de hoje (para a lista "Agendadas"). */
export function templateNextDate(tpl, today = todayYmd()) {
  if (!tpl.recurrence) return null;
  const last = lastHandledDate(tpl.id);
  let from = today;
  if (last && addDays(last, 1) > from) from = addDays(last, 1);
  return nextOccurrence(tpl.recurrence, anchorOf(tpl, today), from);
}

const MANUAL = 'COALESCE(sort_order, id), id';

const ORDER_OPEN = `
  ORDER BY
    CASE WHEN due_date IS NOT NULL AND due_date < ? THEN 0 ELSE 1 END,
    priority DESC,
    CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date,
    created_at
`;

export function listTasks(view, today = todayYmd()) {
  const db = getDb();
  switch (view) {
    case 'today':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0
        AND (start_date IS NULL OR start_date <= ?) ${ORDER_OPEN}`).all(today, today).map(row);
    case 'scheduled':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0
        AND start_date > ? ORDER BY start_date, priority DESC, created_at`).all(today).map(row);
    case 'all':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0 ${ORDER_OPEN}`).all(today).map(row);
    case 'someday':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 1
        ORDER BY ${MANUAL}`).all().map(row);
    case 'doing':
    case 'leticia':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND status = ?
        ORDER BY ${MANUAL}`).all(view).map(row);
    case 'completed':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NOT NULL
        ORDER BY completed_at DESC LIMIT 300`).all().map(row);
    case 'templates':
      return db.prepare('SELECT * FROM tasks WHERE is_template = 1 ORDER BY completed_at IS NOT NULL, title').all()
        .map(row).map((t) => ({ ...t, next_date: t.completed_at ? null : templateNextDate(t, today) }));
    default:
      throw new Error('view inválida');
  }
}

export function counts(today = todayYmd()) {
  const db = getDb();
  const one = (sql, ...p) => Number(db.prepare(sql).get(...p).n);
  return {
    today: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0 AND (start_date IS NULL OR start_date <= ?)', today),
    overdue: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND due_date < ?', today),
    scheduled: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0 AND start_date > ?', today),
    all: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 0'),
    someday: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 1'),
    doing: one("SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND status = 'doing'"),
    leticia: one("SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND status = 'leticia'"),
    completed: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NOT NULL'),
    templates: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 1 AND completed_at IS NULL'),
  };
}

/**
 * Visão semanal ("bloco de papel"): sete dias com as tarefas datadas e as
 * recorrências previstas, mais as tarefas sem data (sempre visíveis) e as
 * atrasadas de semanas anteriores.
 *
 * Regras de posicionamento:
 * - Tarefa com prazo: no dia do prazo (aberta ou concluída, riscada).
 * - Tarefa agendada (start_date futura, sem prazo): no dia em que entra na lista.
 * - Tarefa sem prazo já na lista: em "A fazer" (undated). Se concluída nesta semana, no dia da conclusão.
 * - Tarefa "Sem data" (someday): lista à parte, sem datas; concluída nesta semana, no dia da conclusão.
 * - Recorrência sem ocorrência criada ainda: prevista (virtual) nos dias >= hoje.
 */
export function weekView(start, today = todayYmd()) {
  const db = getDb();
  const end = addDays(start, 6);

  // Só tarefas abertas: as concluídas saem da folha da semana (ficam em "Concluídas")
  const rows = db.prepare(`
    SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND (
      (due_date BETWEEN ? AND ?)
      OR (due_date IS NULL AND start_date BETWEEN ? AND ? AND start_date > ?)
    )
  `).all(start, end, start, end, today).map(row);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const tasks = rows.filter((t) => (t.due_date ? t.due_date === date : t.start_date === date))
      .map((t) => ({ ...t, kind: t.due_date ? 'due' : 'scheduled' }));
    days.push({ date, tasks });
  }

  // Recorrências previstas (ainda sem ocorrência materializada), só de hoje em diante
  const templates = db.prepare('SELECT * FROM tasks WHERE is_template = 1 AND completed_at IS NULL').all().map(row);
  const existing = new Set([
    ...db.prepare('SELECT template_id, occurrence_date FROM tasks WHERE template_id IS NOT NULL AND occurrence_date BETWEEN ? AND ?')
      .all(start, end).map((r) => `${r.template_id}|${r.occurrence_date}`),
    ...db.prepare('SELECT template_id, occurrence_date FROM skipped_occurrences WHERE occurrence_date BETWEEN ? AND ?')
      .all(start, end).map((r) => `${r.template_id}|${r.occurrence_date}`),
  ]);
  for (const tpl of templates) {
    if (!tpl.recurrence) continue;
    const anchor = anchorOf(tpl, today);
    for (const day of days) {
      if (day.date < today || day.date < anchor) continue;
      if (existing.has(`${tpl.id}|${day.date}`)) continue;
      if (!matches(tpl.recurrence, anchor, day.date)) continue;
      day.tasks.push({
        id: null, virtual: true, kind: 'projected', template_id: tpl.id, title: tpl.title, notes: tpl.notes,
        priority: tpl.priority, due_date: day.date, completed_at: null, source: tpl.source,
        recurrence_label: tpl.recurrence_label,
      });
    }
  }

  const sortItems = (a, b) => (Boolean(a.completed_at) - Boolean(b.completed_at)) || (b.priority - a.priority)
    || String(a.title).localeCompare(String(b.title), 'pt-BR');
  for (const day of days) day.tasks.sort(sortItems);

  // "A fazer": abertas, sem prazo, já na lista, ainda não em andamento (ordem manual)
  const undated = db.prepare(`
    SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND due_date IS NULL AND someday = 0
      AND status = 'todo' AND (start_date IS NULL OR start_date <= ?)
    ORDER BY ${MANUAL}
  `).all(today).map(row);

  // "Sem data": algum dia, quando a condição acontecer
  const someday = db.prepare(`
    SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND someday = 1
    ORDER BY ${MANUAL}
  `).all().map(row);

  // "Em andamento" e "Ver com Letícia": todas as abertas nessa situação, com ou sem prazo
  const byStatus = (st) => db.prepare(`
    SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND status = ? ORDER BY ${MANUAL}
  `).all(st).map(row);
  const doing = byStatus('doing');
  const leticia = byStatus('leticia');

  const overdue = db.prepare(`
    SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND due_date < ? AND due_date < ?
    ORDER BY due_date, priority DESC
  `).all(start, today).map(row);

  return { start, end, today, days, undated, someday, doing, leticia, overdue };
}

/** Lembretes vencidos ainda não enviados (remind_at <= agora, tarefa aberta). */
export function dueReminders(nowLocal) {
  return getDb().prepare(`
    SELECT * FROM tasks WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND completed_at IS NULL
      AND remind_at <= ? ORDER BY remind_at
  `).all(nowLocal).map(row);
}

export function markReminded(id) {
  getDb().prepare('UPDATE tasks SET reminded_at = ? WHERE id = ?').run(nowIso(), id);
}

/**
 * Move uma tarefa (arrastar e soltar):
 * - list: 'todo' | 'doing' | 'leticia' | 'someday' (folha de destino)
 * - order: ids da folha de destino na nova ordem (inclui a tarefa movida)
 * - due_date: solta num dia da semana -> novo prazo
 */
export function moveTask(id, { list, order, due_date } = {}) {
  const db = getDb();
  const t = getTask(id);
  if (!t || t.is_template) throw new Error('Tarefa não encontrada');
  if (t.completed_at) throw new Error('Tarefa já concluída');

  if (due_date !== undefined) {
    if (!cleanDate(due_date)) throw new Error('Data inválida');
    updateTask(id, { due_date });
  }

  if (list !== undefined) {
    if (list === 'someday') {
      if (t.due_date || t.template_id) throw new Error('Tarefas com prazo ou recorrentes não vão para "Sem data". Tire o prazo antes.');
      updateTask(id, { someday: true, status: 'todo' });
    } else {
      const status = cleanStatus(list);
      updateTask(id, { status, ...(t.someday ? { someday: false } : {}) });
    }
  }

  if (Array.isArray(order) && order.length) {
    const ids = order.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const stmt = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ? AND is_template = 0');
    db.exec('BEGIN');
    try {
      ids.forEach((tid, i) => stmt.run(i + 1, tid));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return getTask(id);
}
