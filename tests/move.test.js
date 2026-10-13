import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../src/db/database.js';
import { createTask, updateTask, getTask, listTasks, moveTask, weekView, counts } from '../src/services/tasks.js';
import { today as todayYmd, mondayOf } from '../src/services/dates.js';

beforeEach(() => useMemoryDb());

const week = () => weekView(mondayOf(todayYmd()), todayYmd());
const titles = (l) => l.map((t) => t.title);

test('novas tarefas entram no fim de "A fazer"; prioridade alta entra no topo', () => {
  createTask({ title: 'A' });
  createTask({ title: 'B' });
  createTask({ title: 'Urgente', priority: true });
  assert.deepEqual(titles(week().undated), ['Urgente', 'A', 'B']);
});

test('reordenar "A fazer" arrastando', () => {
  const a = createTask({ title: 'A' });
  const b = createTask({ title: 'B' });
  const c = createTask({ title: 'C' });
  moveTask(c.id, { list: 'todo', order: [c.id, a.id, b.id] });
  assert.deepEqual(titles(week().undated), ['C', 'A', 'B']);
  moveTask(a.id, { list: 'todo', order: [c.id, b.id, a.id] });
  assert.deepEqual(titles(week().undated), ['C', 'B', 'A']);
});

test('mover para "Em andamento" e "Ver com Letícia" tira de "A fazer"', () => {
  const a = createTask({ title: 'A' });
  const b = createTask({ title: 'B' });
  createTask({ title: 'C' });
  moveTask(a.id, { list: 'doing', order: [a.id] });
  moveTask(b.id, { list: 'leticia', order: [b.id] });
  const w = week();
  assert.deepEqual(titles(w.undated), ['C']);
  assert.deepEqual(titles(w.doing), ['A']);
  assert.deepEqual(titles(w.leticia), ['B']);
  assert.equal(getTask(a.id).status, 'doing');
  assert.deepEqual(titles(listTasks('doing')), ['A']);
  assert.equal(counts().doing, 1);
  assert.equal(counts().leticia, 1);
  // volta para "A fazer" na posição escolhida
  const c = week().undated[0];
  moveTask(a.id, { list: 'todo', order: [a.id, c.id] });
  assert.deepEqual(titles(week().undated), ['A', 'C']);
  assert.equal(week().doing.length, 0);
});

test('tarefa com prazo em andamento aparece na ficha e no dia', () => {
  const t = createTask({ title: 'Com prazo', due_date: todayYmd() });
  moveTask(t.id, { list: 'doing', order: [t.id] });
  const w = week();
  assert.deepEqual(titles(w.doing), ['Com prazo']);
  assert.ok(w.days.find((d) => d.date === todayYmd()).tasks.some((x) => x.id === t.id));
  assert.equal(w.undated.length, 0);
});

test('"Sem data": entra e sai arrastando; tarefa com prazo é recusada', () => {
  const a = createTask({ title: 'A' });
  moveTask(a.id, { list: 'someday', order: [a.id] });
  assert.equal(getTask(a.id).someday, true);
  assert.deepEqual(titles(week().someday), ['A']);
  moveTask(a.id, { list: 'doing', order: [a.id] });
  assert.equal(getTask(a.id).someday, false);
  assert.equal(getTask(a.id).status, 'doing');
  const p = createTask({ title: 'P', due_date: '2999-01-01' });
  assert.throws(() => moveTask(p.id, { list: 'someday' }), /prazo/);
});

test('soltar num dia da semana define o prazo (inclusive vindo de "Sem data")', () => {
  const a = createTask({ title: 'A' });
  moveTask(a.id, { due_date: '2999-02-03' });
  assert.equal(getTask(a.id).due_date, '2999-02-03');
  assert.equal(week().undated.length, 0);
  const s = createTask({ title: 'S', someday: true });
  moveTask(s.id, { due_date: '2999-02-04' });
  assert.equal(getTask(s.id).someday, false);
  assert.equal(getTask(s.id).due_date, '2999-02-04');
  assert.throws(() => moveTask(a.id, { due_date: 'amanhã' }), /Data inválida/);
});

test('situação pelo editor e validação', () => {
  const a = createTask({ title: 'A', status: 'leticia' });
  assert.equal(a.status, 'leticia');
  updateTask(a.id, { status: 'doing' });
  assert.equal(getTask(a.id).status, 'doing');
  assert.throws(() => updateTask(a.id, { status: 'xyz' }), /Situação inválida/);
  assert.throws(() => createTask({ title: 'B', status: 'xyz' }), /Situação inválida/);
  const done = createTask({ title: 'D' });
  updateTask(done.id, { completed: true });
  assert.throws(() => moveTask(done.id, { list: 'doing' }), /concluída/);
});
