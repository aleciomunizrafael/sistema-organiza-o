import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../src/db/database.js';
import { today as todayYmd, addDays } from '../src/services/dates.js';
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
  // semana real de hoje; regra: hoje e daqui a 2 dias (dias da semana), ancorada 14 dias atrás
  const today = todayYmd();
  const wd = new Date(today + 'T12:00:00').getDay();
  const wd2 = (wd + 2) % 7;
  createTask({ title: 'Relatório', recurrence: { freq: 'weekly', interval: 1, weekdays: [wd, wd2].sort() }, start_date: addDays(today, -14) });
  const monday = addDays(today, -((wd + 6) % 7));
  const w = weekView(monday, today);
  const hoje = day(w, today).tasks[0];
  assert.equal(hoje.title, 'Relatório');
  assert.equal(hoje.virtual, undefined); // materializada (última <= hoje)
  assert.ok(hoje.id);
  const in2 = addDays(today, 2);
  if (in2 <= w.end) {
    const fut = day(w, in2).tasks[0];
    assert.equal(fut.virtual, true);
    assert.equal(fut.kind, 'projected');
    assert.equal(fut.id, null);
  }
  assert.equal(day(w, addDays(today, 1)).tasks.length, 0);
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

test('"sem data" (someday) fica na lista própria, fora de "A fazer" e dos dias', () => {
  createTask({ title: 'A fazer', });
  createTask({ title: 'Algum dia', someday: true, trigger_text: 'quando o papel acabar' });
  const w = weekView(START, TODAY);
  assert.deepEqual(titles(w.undated), ['A fazer']);
  assert.deepEqual(titles(w.someday), ['Algum dia']);
  assert.equal(w.days.every((d) => !titles(d.tasks).includes('Algum dia')), true);
});
