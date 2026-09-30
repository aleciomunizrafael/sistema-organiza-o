import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../src/db/database.js';
import { createTask, updateTask, weekView } from '../src/services/tasks.js';

// Semana de 28/09/2026 (segunda) a 04/10/2026 (domingo); "hoje" = quarta 30/09
const START = '2026-09-28';
const TODAY = '2026-09-30';

beforeEach(() => useMemoryDb());

const titles = (list) => list.map((t) => t.title);
const day = (w, date) => w.days.find((d) => d.date === date);

test('estrutura: sete dias a partir da segunda', () => {
  const w = weekView(START, TODAY);
  assert.equal(w.days.length, 7);
  assert.equal(w.days[0].date, '2026-09-28');
  assert.equal(w.days[6].date, '2026-10-04');
  assert.equal(w.end, '2026-10-04');
});

test('tarefa com prazo cai no dia do prazo; sem data vai para "Sem data"', () => {
  createTask({ title: 'Com prazo', due_date: '2026-10-01' });
  createTask({ title: 'Sem prazo' });
  const w = weekView(START, TODAY);
  assert.deepEqual(titles(day(w, '2026-10-01').tasks), ['Com prazo']);
  assert.equal(day(w, '2026-10-01').tasks[0].kind, 'due');
  assert.deepEqual(titles(w.undated), ['Sem prazo']);
});

test('tarefa agendada (sem prazo) aparece no dia em que entra; depois de entrar, vai para "Sem data"', () => {
  createTask({ title: 'Futura', start_date: '2026-10-03' });
  createTask({ title: 'Já entrou', start_date: '2026-09-29' });
  const w = weekView(START, TODAY);
  assert.deepEqual(titles(day(w, '2026-10-03').tasks), ['Futura']);
  assert.equal(day(w, '2026-10-03').tasks[0].kind, 'scheduled');
  assert.deepEqual(titles(day(w, '2026-09-29').tasks), []);
  assert.deepEqual(titles(w.undated), ['Já entrou']);
});

test('atrasadas de semanas anteriores aparecem em "overdue", não nos dias', () => {
  createTask({ title: 'Velha', due_date: '2026-09-20' });
  const w = weekView(START, TODAY);
  assert.deepEqual(titles(w.overdue), ['Velha']);
  assert.equal(w.days.every((d) => !titles(d.tasks).includes('Velha')), true);
  // na semana em que ela vence, aparece no dia
  const w2 = weekView('2026-09-14', TODAY);
  assert.deepEqual(titles(day(w2, '2026-09-20').tasks), ['Velha']);
  assert.equal(w2.overdue.length, 0);
});

test('concluídas: com prazo ficam no dia do prazo, sem prazo no dia da conclusão', () => {
  const a = createTask({ title: 'Feita com prazo', due_date: '2026-09-29' });
  updateTask(a.id, { completed: true });
  const b = createTask({ title: 'Feita sem prazo' });
  updateTask(b.id, { completed: true });
  const w = weekView(START, TODAY);
  const doneA = day(w, '2026-09-29').tasks.find((t) => t.title === 'Feita com prazo');
  assert.ok(doneA && doneA.completed_at);
  const realToday = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const todayReal = `${realToday.getFullYear()}-${p(realToday.getMonth() + 1)}-${p(realToday.getDate())}`;
  const wReal = weekView(START, TODAY);
  const found = wReal.days.flatMap((d) => d.tasks).find((t) => t.title === 'Feita sem prazo');
  // só aparece se a conclusão (data real) cair dentro da semana consultada
  if (todayReal >= START && todayReal <= '2026-10-04') {
    assert.ok(found, 'concluída sem prazo deveria aparecer no dia da conclusão');
    assert.equal(found.kind, 'done');
  } else {
    assert.equal(found, undefined);
  }
  assert.equal(w.undated.some((t) => t.title === 'Feita sem prazo'), false);
});

test('recorrência: ocorrência criada aparece como real, futuras como previstas', () => {
  createTask({ title: 'Relatório', recurrence: { freq: 'weekly', interval: 1, weekdays: [1, 5] }, start_date: '2026-09-01' });
  const w = weekView(START, TODAY);
  // segunda 28/09 é a última ocorrência <= hoje: materializada
  const seg = day(w, '2026-09-28').tasks[0];
  assert.equal(seg.title, 'Relatório');
  assert.equal(seg.virtual, undefined);
  assert.ok(seg.id);
  // sexta 02/10 é futura: prevista
  const sex = day(w, '2026-10-02').tasks[0];
  assert.equal(sex.virtual, true);
  assert.equal(sex.kind, 'projected');
  assert.equal(sex.id, null);
  // terça não tem
  assert.equal(day(w, '2026-09-29').tasks.length, 0);
});

test('recorrência pausada não gera previsões; dias passados sem ocorrência ficam vazios', () => {
  const tpl = createTask({ title: 'Diária', recurrence: 'daily', start_date: '2026-09-01' });
  updateTask(tpl.id, { completed: true }); // pausa
  const w = weekView(START, TODAY);
  const projected = w.days.flatMap((d) => d.tasks).filter((t) => t.virtual);
  assert.equal(projected.length, 0);
});

test('semana futura mostra só previsões e agendadas', () => {
  createTask({ title: 'Dias úteis', recurrence: 'weekdays', start_date: '2026-09-01' });
  createTask({ title: 'Agendada', start_date: '2026-10-07' });
  const w = weekView('2026-10-05', TODAY);
  assert.equal(day(w, '2026-10-05').tasks[0].virtual, true);
  assert.equal(day(w, '2026-10-10').tasks.length, 0); // sábado
  assert.deepEqual(titles(day(w, '2026-10-07').tasks).sort(), ['Agendada', 'Dias úteis']);
});

test('ordenação no dia: abertas antes das concluídas, prioridade alta primeiro', () => {
  const a = createTask({ title: 'B normal', due_date: '2026-10-01' });
  createTask({ title: 'A alta', due_date: '2026-10-01', priority: true });
  const c = createTask({ title: 'C feita', due_date: '2026-10-01' });
  updateTask(c.id, { completed: true });
  const w = weekView(START, TODAY);
  assert.deepEqual(titles(day(w, '2026-10-01').tasks), ['A alta', 'B normal', 'C feita']);
  assert.ok(a.id);
});
