import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, nextOccurrence, lastOccurrenceUpTo, normalizeRule, describeRule } from '../src/services/recurrence.js';

test('diária a cada 3 dias', () => {
  const rule = { freq: 'daily', interval: 3 };
  assert.equal(matches(rule, '2026-09-01', '2026-09-04'), true);
  assert.equal(matches(rule, '2026-09-01', '2026-09-05'), false);
  assert.equal(nextOccurrence(rule, '2026-09-01', '2026-09-05'), '2026-09-07');
});

test('semanal em seg/qua/sex', () => {
  const rule = { freq: 'weekly', interval: 1, weekdays: [1, 3, 5] };
  assert.equal(nextOccurrence(rule, '2026-09-30', '2026-09-30'), '2026-09-30'); // quarta
  assert.equal(nextOccurrence(rule, '2026-09-30', '2026-10-01'), '2026-10-02'); // sexta
  assert.equal(nextOccurrence(rule, '2026-09-30', '2026-10-03'), '2026-10-05'); // segunda
});

test('quinzenal respeita semanas alternadas', () => {
  const rule = { freq: 'weekly', interval: 2 };
  assert.equal(matches(rule, '2026-09-30', '2026-10-07'), false);
  assert.equal(matches(rule, '2026-09-30', '2026-10-14'), true);
});

test('mensal no dia 31 cai no último dia em meses curtos', () => {
  const rule = { freq: 'monthly', interval: 1, monthDay: 31 };
  assert.equal(nextOccurrence(rule, '2026-01-31', '2026-02-01'), '2026-02-28');
  assert.equal(nextOccurrence(rule, '2026-01-31', '2026-03-01'), '2026-03-31');
});

test('anual', () => {
  const rule = { freq: 'yearly', interval: 1 };
  assert.equal(nextOccurrence(rule, '2026-03-15', '2026-03-16'), '2027-03-15');
});

test('until limita as ocorrências', () => {
  const rule = { freq: 'daily', interval: 1, until: '2026-10-02' };
  assert.equal(nextOccurrence(rule, '2026-09-30', '2026-10-03'), null);
  assert.equal(lastOccurrenceUpTo(rule, '2026-09-30', '2026-10-10'), '2026-10-02');
});

test('lastOccurrenceUpTo encontra a mais recente', () => {
  const rule = { freq: 'weekly', interval: 1, weekdays: [1] };
  assert.equal(lastOccurrenceUpTo(rule, '2026-09-01', '2026-09-30'), '2026-09-28');
});

test('normalizeRule aceita presets e strings JSON', () => {
  assert.deepEqual(normalizeRule('weekdays'), { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
  assert.deepEqual(normalizeRule('{"freq":"monthly","interval":"2","monthDay":"10"}'), { freq: 'monthly', interval: 2, monthDay: 10 });
  assert.equal(normalizeRule('xyz'), null);
});

test('describeRule', () => {
  assert.equal(describeRule({ freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }), 'Dias úteis');
  assert.equal(describeRule({ freq: 'monthly', interval: 1, monthDay: 5 }), 'Todo mês no dia 5');
});

test('mensal em vários dias (monthDays), com dia 31 caindo no último dia do mês', () => {
  const rule = normalizeRule({ freq: 'monthly', interval: 1, monthDays: [15, 31] });
  assert.deepEqual(rule.monthDays, [15, 31]);
  assert.equal(matches(rule, '2026-01-01', '2026-02-15'), true);
  assert.equal(matches(rule, '2026-01-01', '2026-02-28'), true);
  assert.equal(matches(rule, '2026-01-01', '2026-02-20'), false);
  assert.equal(nextOccurrence(rule, '2026-01-01', '2026-03-16'), '2026-03-31');
  assert.equal(describeRule(rule), 'Todo mês nos dias 15 e 31');
  assert.deepEqual(normalizeRule({ freq: 'monthly', monthDays: [5] }), { freq: 'monthly', interval: 1, monthDay: 5 });
});
