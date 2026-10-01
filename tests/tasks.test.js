import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../src/db/database.js';
import { today as todayYmd, addDays } from '../src/services/dates.js';
import { createTask, updateTask, listTasks, ensureOccurrence, materializeAll, counts, deleteTask, getTask } from '../src/services/tasks.js';

beforeEach(() => useMemoryDb());

test('tarefa simples aparece em Hoje e some ao concluir', () => {
  const t = createTask({ title: 'Comprar café' });
  assert.equal(listTasks('today').length, 1);
  updateTask(t.id, { completed: true });
  assert.equal(listTasks('today').length, 0);
  assert.equal(listTasks('completed').length, 1);
});

test('tarefa agendada só entra na lista na data', () => {
  createTask({ title: 'Futuro', start_date: '2999-01-01' });
  assert.equal(listTasks('today', '2026-09-30').length, 0);
  assert.equal(listTasks('scheduled', '2026-09-30').length, 1);
  assert.equal(listTasks('today', '2999-01-01').length, 1);
});

test('recorrente cria apenas uma ocorrência aberta por vez', () => {
  const tpl = createTask({ title: 'Relatório', recurrence: { freq: 'daily', interval: 1 }, start_date: '2026-09-01' });
  assert.equal(tpl.is_template, true);
  // já materializou uma ocorrência (a mais recente <= hoje)
  const open = listTasks('all');
  assert.equal(open.length, 1);
  assert.equal(open[0].template_id, tpl.id);
  // rodar de novo não duplica
  assert.equal(materializeAll(), 0);
  assert.equal(listTasks('all').length, 1);
});

test('ao concluir a ocorrência, a próxima só surge quando chegar o dia', () => {
  const today = todayYmd();
  const tpl = createTask({ title: 'Diária', recurrence: 'daily', start_date: addDays(today, -2) });
  const [occ] = listTasks('all', today);
  assert.equal(occ.occurrence_date, today);
  updateTask(occ.id, { completed: true });
  // ainda hoje: nada novo (a próxima é amanhã)
  assert.equal(listTasks('all', today).filter((t) => t.template_id === tpl.id).length, 0);
  // amanhã: cria a nova ocorrência
  ensureOccurrence(tpl.id, addDays(today, 1));
  const next = listTasks('all', addDays(today, 1)).filter((t) => t.template_id === tpl.id);
  assert.equal(next.length, 1);
  assert.equal(next[0].occurrence_date, addDays(today, 1));
});

test('dias perdidos com o sistema desligado não acumulam', () => {
  const tpl = createTask({ title: 'Backup', recurrence: 'daily', start_date: '2026-09-01' });
  const [occ] = listTasks('all');
  assert.equal(occ.occurrence_date, todayYmd()); // só a mais recente, não desde 01/09
  updateTask(occ.id, { completed: true });
  // sistema volta 10 dias depois: só a ocorrência mais recente é criada
  const later = addDays(todayYmd(), 10);
  ensureOccurrence(tpl.id, later);
  const open = listTasks('all', later).filter((t) => t.template_id === tpl.id);
  assert.equal(open.length, 1);
  assert.equal(open[0].occurrence_date, later);
});

test('ocorrência não é recriada para a mesma data após concluída', () => {
  const today = todayYmd();
  const wd = new Date(today + 'T12:00:00').getDay();
  const tpl = createTask({ title: 'Semanal', recurrence: { freq: 'weekly', interval: 1, weekdays: [wd] }, start_date: today });
  const [occ] = listTasks('all', today);
  assert.equal(occ.occurrence_date, today);
  updateTask(occ.id, { completed: true });
  assert.equal(ensureOccurrence(tpl.id, today), null);
  assert.equal(ensureOccurrence(tpl.id, addDays(today, 6)), null);
  assert.equal(ensureOccurrence(tpl.id, addDays(today, 7)).occurrence_date, addDays(today, 7));
});

test('editar o modelo propaga para a ocorrência aberta', () => {
  const tpl = createTask({ title: 'Antigo', recurrence: 'daily' });
  updateTask(tpl.id, { title: 'Novo', priority: true });
  const [occ] = listTasks('all');
  assert.equal(occ.title, 'Novo');
  assert.equal(occ.priority, 1);
});

test('pausar o modelo impede novas ocorrências; excluir remove tudo', () => {
  const tpl = createTask({ title: 'Pausável', recurrence: 'daily', start_date: '2026-09-01' });
  updateTask(tpl.id, { completed: true }); // pausa
  const [occ] = listTasks('all', '2026-09-30');
  updateTask(occ.id, { completed: true });
  assert.equal(ensureOccurrence(tpl.id, '2026-10-05'), null);
  deleteTask(tpl.id);
  assert.equal(listTasks('completed').length, 0);
});

test('mensagem do WhatsApp com mesmo id não duplica', () => {
  createTask({ title: 'Demanda', source: 'whatsapp', source_message_id: 'ABC' });
  assert.throws(() => createTask({ title: 'Demanda', source: 'whatsapp', source_message_id: 'ABC' }), /UNIQUE/);
});

test('contadores', () => {
  createTask({ title: 'A' });
  createTask({ title: 'B', due_date: '2020-01-01' });
  createTask({ title: 'C', start_date: '2999-01-01' });
  const c = counts('2026-09-30');
  assert.equal(c.today, 2);
  assert.equal(c.overdue, 1);
  assert.equal(c.scheduled, 1);
  assert.equal(c.all, 3);
});

test('validação de datas', () => {
  assert.throws(() => createTask({ title: 'X', due_date: '2026-13-45' }), /Data inválida/);
  assert.throws(() => createTask({ title: '   ' }), /Título/);
});

test('"sem data" (someday): fora de Hoje/Todas, sem datas, com condição em texto', () => {
  const t = createTask({ title: 'Comprar papel de outro fornecedor', someday: true, trigger_text: 'quando o papel acabar', due_date: '2026-10-05' });
  assert.equal(t.someday, true);
  assert.equal(t.due_date, null); // datas são ignoradas em "sem data"
  assert.equal(t.trigger_text, 'quando o papel acabar');
  assert.equal(listTasks('today').length, 0);
  assert.equal(listTasks('all').length, 0);
  assert.deepEqual(listTasks('someday').map((x) => x.title), ['Comprar papel de outro fornecedor']);
  assert.equal(counts().someday, 1);
});

test('"sem data" volta para "a fazer" ao ganhar uma data ou ao trocar o modo', () => {
  const t = createTask({ title: 'Guardada', someday: true });
  updateTask(t.id, { due_date: '2026-12-01' });
  assert.equal(getTask(t.id).someday, false);
  assert.equal(getTask(t.id).due_date, '2026-12-01');
  updateTask(t.id, { someday: true });
  assert.equal(getTask(t.id).someday, true);
  assert.equal(getTask(t.id).due_date, null);
  updateTask(t.id, { someday: false });
  assert.equal(getTask(t.id).someday, false);
  assert.equal(listTasks('today').length, 1);
});

test('recorrência ignora o modo "sem data"', () => {
  const t = createTask({ title: 'Diária', recurrence: 'daily', someday: true });
  assert.equal(t.is_template, false);
  assert.equal(t.someday, true);
  const tpl = createTask({ title: 'Semanal', recurrence: 'weekly' });
  updateTask(tpl.id, { someday: true });
  assert.equal(getTask(tpl.id).someday, false);
});

// ---------- correções da auditoria ----------

test('modelo nunca fica sem âncora: converter tarefa sem data em recorrente grava hoje em start_date', () => {
  const t = createTask({ title: 'Pagar boleto' });
  updateTask(t.id, { title: 'Pagar boleto', notes: '', start_date: null, due_date: null, priority: false, recurrence: { freq: 'monthly', interval: 1 } });
  const tpl = getTask(t.id);
  assert.equal(tpl.is_template, true);
  assert.equal(tpl.start_date, todayYmd());
  // concluir a ocorrência de hoje e chamar o agendador amanhã: nada novo (regra mensal)
  const [occ] = listTasks('all');
  updateTask(occ.id, { completed: true });
  assert.equal(ensureOccurrence(t.id, addDays(todayYmd(), 1)), null);
  // apagar "Começa em" de um modelo mantém a âncora anterior
  updateTask(t.id, { start_date: '' });
  assert.equal(getTask(t.id).start_date, todayYmd());
});

test('ocorrência não vira modelo: recurrence em PATCH de ocorrência é ignorada', () => {
  const tpl = createTask({ title: 'Semanal', recurrence: 'weekly', start_date: '2026-09-01' });
  const [occ] = listTasks('all');
  updateTask(occ.id, { recurrence: { freq: 'daily', interval: 1 }, someday: true });
  const after = getTask(occ.id);
  assert.equal(after.is_template, false);
  assert.equal(after.recurrence, null);
  assert.equal(after.someday, false);
  assert.equal(after.template_id, tpl.id);
});

test('excluir uma ocorrência não é desfeito pelo agendador', () => {
  const tpl = createTask({ title: 'Diária', recurrence: 'daily', start_date: '2026-09-01' });
  const [occ] = listTasks('all');
  const date = occ.occurrence_date;
  assert.equal(deleteTask(occ.id), true);
  assert.equal(materializeAll(date), 0);
  assert.equal(listTasks('all').filter((t) => t.template_id === tpl.id).length, 0);
  // no dia seguinte a próxima ocorrência é criada normalmente
  const next = ensureOccurrence(tpl.id, addDays(date, 1));
  assert.equal(next.occurrence_date, addDays(date, 1));
  // excluir o modelo remove tudo, inclusive as datas puladas
  deleteTask(tpl.id);
  assert.equal(listTasks('templates').length, 0);
});

test('reabrir ocorrência antiga com outra aberta é recusado', () => {
  const tpl = createTask({ title: 'Diária', recurrence: 'daily', start_date: '2026-09-01' });
  const [first] = listTasks('all');
  updateTask(first.id, { completed: true });
  const created = ensureOccurrence(tpl.id, addDays(first.occurrence_date, 1));
  assert.ok(created);
  assert.throws(() => updateTask(first.id, { completed: false }), /ocorrência aberta/);
  // sem outra aberta, reabrir funciona
  updateTask(created.id, { completed: true });
  assert.equal(ensureOccurrence(tpl.id, created.occurrence_date), null);
  updateTask(first.id, { completed: false });
  assert.equal(getTask(first.id).completed_at, null);
});

test('modelo pausado convertido em "não repete" vira tarefa aberta, não concluída', () => {
  const tpl = createTask({ title: 'Pausável', recurrence: 'daily' });
  updateTask(tpl.id, { completed: true }); // pausa
  updateTask(tpl.id, { recurrence: null });
  const t = getTask(tpl.id);
  assert.equal(t.is_template, false);
  assert.equal(t.completed_at, null);
});

test('booleanos vindos como texto e título não textual', () => {
  const t = createTask({ title: 'X', priority: 'false', someday: 'false' });
  assert.equal(t.priority, 0);
  assert.equal(t.someday, false);
  updateTask(t.id, { completed: 'false' });
  assert.equal(getTask(t.id).completed_at, null);
  updateTask(t.id, { completed: 'true' });
  assert.ok(getTask(t.id).completed_at);
  assert.throws(() => createTask({ title: { a: 1 } }), /Título/);
  assert.throws(() => createTask({ title: 'ok', notes: ['x'] }), /Texto inválido/);
});
