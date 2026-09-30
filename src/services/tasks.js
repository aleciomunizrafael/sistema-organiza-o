import { getDb, nowIso } from '../db/database.js';
import { today as todayYmd, isValidYmd, addDays } from './dates.js';
import { normalizeRule, nextOccurrence, lastOccurrenceUpTo, describeRule } from './recurrence.js';

function row(r) {
  if (!r) return null;
  const rule = r.recurrence ? JSON.parse(r.recurrence) : null;
  return {
    ...r,
    priority: Number(r.priority),
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

export function getTask(id) {
  return row(getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

/**
 * Cria uma tarefa. Se `recurrence` for informada, cria um modelo recorrente e
 * materializa a primeira ocorrência quando ela já estiver no prazo.
 */
export function createTask(input) {
  const db = getDb();
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Título obrigatório');
  const notes = String(input.notes || '').trim();
  const priority = input.priority ? 1 : 0;
  const rule = normalizeRule(input.recurrence);
  let startDate = cleanDate(input.start_date);
  let dueDate = cleanDate(input.due_date);
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
    INSERT INTO tasks (title, notes, start_date, due_date, priority, source, source_sender, source_text,
                       source_message_id, source_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, notes, startDate, dueDate, priority, source, input.source_sender ?? null, input.source_text ?? null,
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

  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (!t) throw new Error('Título obrigatório');
    set('title', t);
  }
  if (input.notes !== undefined) set('notes', String(input.notes || '').trim());
  if (input.priority !== undefined) set('priority', input.priority ? 1 : 0);
  if (input.start_date !== undefined) set('start_date', cleanDate(input.start_date));
  if (input.due_date !== undefined && !current.is_template) set('due_date', cleanDate(input.due_date));

  if (input.completed !== undefined) {
    set('completed_at', input.completed ? nowIso() : null);
  }

  if (input.recurrence !== undefined) {
    const rule = normalizeRule(input.recurrence);
    if (current.is_template) {
      if (rule) set('recurrence', JSON.stringify(rule));
      else {
        // Deixa de ser recorrente: vira tarefa comum (ocorrências existentes ficam)
        set('recurrence', null);
        set('is_template', 0);
        // remove ocorrências abertas futuras para não duplicar
        db.prepare('DELETE FROM tasks WHERE template_id = ? AND completed_at IS NULL').run(id);
      }
    } else if (rule) {
      set('recurrence', JSON.stringify(rule));
      set('is_template', 1);
      set('due_date', null);
      if (!current.start_date && input.start_date === undefined) set('start_date', todayYmd());
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
  const r = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return r.changes > 0;
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

  const last = db.prepare('SELECT MAX(occurrence_date) AS d FROM tasks WHERE template_id = ?').get(templateId)?.d || null;
  const anchor = tpl.start_date || today;

  // Candidata: última data <= hoje que ainda não foi materializada
  let date = lastOccurrenceUpTo(tpl.recurrence, anchor, today);
  if (!date || (last && date <= last)) return null;

  const r = db.prepare(`
    INSERT OR IGNORE INTO tasks (title, notes, start_date, due_date, priority, source, source_sender,
                                 template_id, occurrence_date)
    VALUES (?, ?, ?, ?, ?, 'recurrence', ?, ?, ?)
  `).run(tpl.title, tpl.notes, date, date, tpl.priority, tpl.source_sender, templateId, date);
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
  const last = getDb().prepare('SELECT MAX(occurrence_date) AS d FROM tasks WHERE template_id = ?').get(tpl.id)?.d || null;
  let from = today;
  if (last && addDays(last, 1) > from) from = addDays(last, 1);
  return nextOccurrence(tpl.recurrence, tpl.start_date || today, from);
}

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
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL
        AND (start_date IS NULL OR start_date <= ?) ${ORDER_OPEN}`).all(today, today).map(row);
    case 'scheduled':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL
        AND start_date > ? ORDER BY start_date, priority DESC, created_at`).all(today).map(row);
    case 'all':
      return db.prepare(`SELECT * FROM tasks WHERE is_template = 0 AND completed_at IS NULL ${ORDER_OPEN}`).all(today).map(row);
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
    today: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND (start_date IS NULL OR start_date <= ?)', today),
    overdue: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND due_date < ?', today),
    scheduled: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL AND start_date > ?', today),
    all: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NULL'),
    completed: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 0 AND completed_at IS NOT NULL'),
    templates: one('SELECT COUNT(*) n FROM tasks WHERE is_template = 1 AND completed_at IS NULL'),
  };
}
