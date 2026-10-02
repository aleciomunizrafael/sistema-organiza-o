import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb } from '../src/db/database.js';
import { createTask, deleteTask, listTasks, updateTask } from '../src/services/tasks.js';
import { buildCalendar, rruleFor, calendarToken } from '../src/services/ical.js';

beforeEach(() => useMemoryDb());

test('token do calendário é estável e muda só ao rotacionar', () => {
  const a = calendarToken();
  assert.equal(calendarToken(), a);
  assert.notEqual(calendarToken({ rotate: true }), a);
});

test('regras de recorrência viram RRULE', () => {
  assert.equal(rruleFor({ freq: 'daily', interval: 1 }, '2026-10-01'), 'FREQ=DAILY');
  assert.equal(rruleFor({ freq: 'weekly', interval: 2, weekdays: [1, 5] }, '2026-10-01'), 'FREQ=WEEKLY;WKST=MO;BYDAY=MO,FR;INTERVAL=2');
  assert.equal(rruleFor({ freq: 'monthly', interval: 1, monthDays: [15, 30] }, '2026-10-01'), 'FREQ=MONTHLY;BYMONTHDAY=15,30');
  assert.equal(rruleFor({ freq: 'monthly', interval: 1 }, '2026-10-05'), 'FREQ=MONTHLY;BYMONTHDAY=5');
  assert.equal(rruleFor({ freq: 'yearly', interval: 1, until: '2027-12-31' }, '2026-10-01'), 'FREQ=YEARLY;UNTIL=20271231');
});

test('calendário contém prazos, agendadas, lembretes e recorrências; ignora sem data e concluídas', () => {
  createTask({ title: 'Com prazo', due_date: '2026-10-10', priority: true, notes: 'detalhes, com vírgula' });
  createTask({ title: 'Agendada', start_date: '2999-01-05' });
  createTask({ title: 'Só lembrete', remind_at: '2026-10-03T09:30' });
  createTask({ title: 'Sem data', someday: true });
  createTask({ title: 'Sem nada' });
  const tpl = createTask({ title: 'Semanal', recurrence: { freq: 'weekly', interval: 1, weekdays: [1] }, start_date: '2026-09-01' });
  const [occ] = listTasks('all').filter((t) => t.template_id === tpl.id);
  deleteTask(occ.id); // vira EXDATE
  const done = createTask({ title: 'Feita', due_date: '2026-10-11' });
  updateTask(done.id, { completed: true });

  const ics = buildCalendar({ baseUrl: 'https://x.test' });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:! Com prazo/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261010/);
  assert.match(ics, /DESCRIPTION:detalhes\\, com vírgula/);
  assert.match(ics, /SUMMARY:Agendada \(entra na lista\)/);
  assert.match(ics, /SUMMARY:⏰ Só lembrete/);
  assert.match(ics, /DTSTART:20261003T\d{6}Z/);
  assert.match(ics, /SUMMARY:↻ Semanal/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;WKST=MO;BYDAY=MO/);
  assert.match(ics, new RegExp(`EXDATE;VALUE=DATE:${occ.occurrence_date.replace(/-/g, '')}`));
  assert.doesNotMatch(ics, /Sem data/);
  assert.doesNotMatch(ics, /Sem nada/);
  assert.doesNotMatch(ics, /SUMMARY:Feita/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  // nenhuma linha acima de 75 bytes
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `linha longa: ${line}`);
});
