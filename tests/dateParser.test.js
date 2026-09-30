import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDate, extractRecurrence } from '../src/services/dateParser.js';

// 2026-09-30 é uma quarta-feira
const BASE = '2026-09-30';

test('data explícita dd/mm', () => {
  const r = extractDate('Enviar relatório até 15/10', BASE);
  assert.equal(r.date, '2026-10-15');
  assert.equal(r.cleaned, 'Enviar relatório');
});

test('data explícita dd/mm/yyyy e com preposição "para"', () => {
  const r = extractDate('Fechar caixa para 05/01/2027', BASE);
  assert.equal(r.date, '2027-01-05');
  assert.equal(r.cleaned, 'Fechar caixa');
});

test('data sem ano já passada assume ano seguinte', () => {
  assert.equal(extractDate('Renovar contrato em 10/01', BASE).date, '2027-01-10');
});

test('dia da semana: próxima sexta', () => {
  const r = extractDate('Revisar contrato até sexta', BASE);
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.cleaned, 'Revisar contrato');
});

test('dia da semana igual ao de hoje vai para a próxima semana', () => {
  assert.equal(extractDate('Reunião na quarta', BASE).date, '2026-10-07');
});

test('amanhã, hoje, depois de amanhã', () => {
  assert.equal(extractDate('Ligar amanhã', BASE).date, '2026-10-01');
  assert.equal(extractDate('Ligar hoje', BASE).date, '2026-09-30');
  assert.equal(extractDate('Ligar depois de amanhã', BASE).date, '2026-10-02');
});

test('"em N dias" e "próxima semana"', () => {
  assert.equal(extractDate('Cobrar em 3 dias', BASE).date, '2026-10-03');
  assert.equal(extractDate('Cobrar na próxima semana', BASE).date, '2026-10-05');
});

test('"15 de outubro" e "dia 20"', () => {
  assert.equal(extractDate('Pagar boleto 15 de outubro', BASE).date, '2026-10-15');
  assert.equal(extractDate('Pagar boleto até dia 20', BASE).date, '2026-10-20');
  // dia já passado neste mês -> mês seguinte
  assert.equal(extractDate('Pagar boleto dia 5', BASE).date, '2026-10-05');
});

test('fim do mês', () => {
  assert.equal(extractDate('Fechar planilha até o fim do mês', BASE).date, '2026-09-30');
});

test('sem data', () => {
  const r = extractDate('Comprar café', BASE);
  assert.equal(r.date, null);
  assert.equal(r.cleaned, 'Comprar café');
});

test('não confunde horário com data', () => {
  const r = extractDate('Reunião 10/11 14:00', BASE);
  assert.equal(r.date, '2026-11-10');
});

test('recorrência: toda segunda', () => {
  const r = extractRecurrence('Enviar relatório toda segunda');
  assert.deepEqual(r.rule, { freq: 'weekly', interval: 1, weekdays: [1] });
  assert.equal(r.cleaned, 'Enviar relatório');
});

test('recorrência: todo dia 5 (mensal)', () => {
  const r = extractRecurrence('Fechar planilha todo dia 5');
  assert.deepEqual(r.rule, { freq: 'monthly', interval: 1, monthDay: 5 });
});

test('recorrência: todo dia (diária), dias úteis, quinzenal', () => {
  assert.equal(extractRecurrence('Backup todo dia').rule.freq, 'daily');
  assert.deepEqual(extractRecurrence('Conferir e-mail dias úteis').rule.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(extractRecurrence('Reunião quinzenalmente').rule.interval, 2);
});
