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

// ---------- correções da auditoria ----------

test('ordinais de escritório não viram data: "2a via", "segunda via", "3a parcela"', () => {
  for (const s of ['Emitir 2a via do boleto', 'Tirar segunda via do RG', 'Pagar a 3a parcela', 'Comprar 2 vias']) {
    const r = extractDate(s, BASE);
    assert.equal(r.date, null, s);
    assert.equal(r.cleaned, s, s);
  }
  const r = extractDate('Emitir 2a via da NF até sexta', BASE);
  assert.equal(r.date, '2026-10-02');
  assert.equal(r.cleaned, 'Emitir 2a via da NF');
  assert.equal(r.isEnd, true);
});

test('"segunda feira" sem hífen, "2ª feira", "que vem", "nesta", "a partir de"', () => {
  assert.deepEqual([extractDate('Reunião segunda feira', BASE).date, extractDate('Reunião segunda feira', BASE).cleaned], ['2026-10-05', 'Reunião']);
  assert.equal(extractDate('Entregar 2ª feira', BASE).date, '2026-10-05');
  assert.equal(extractDate('Reunião segunda que vem', BASE).cleaned, 'Reunião');
  assert.equal(extractDate('Cobrar semana que vem', BASE).date, '2026-10-05');
  assert.equal(extractDate('Reunião nesta sexta', BASE).cleaned, 'Reunião');
  assert.equal(extractDate('Backup a partir de amanhã', BASE).cleaned, 'Backup');
  assert.equal(extractDate('Marcar 3a', BASE).date, null); // abreviação sem contexto
  assert.equal(extractDate('até 2a', BASE).date, '2026-10-05');
});

test('faixas com hífen e códigos não são datas; ISO e dd-mm com preposição são', () => {
  assert.equal(extractDate('Revisar itens 3-5 do relatório', BASE).date, null);
  assert.equal(extractDate('Processo 2026-1234', BASE).date, null);
  assert.equal(extractDate('Pagar boleto até 2026-12-05', BASE).date, '2026-12-05');
  assert.equal(extractDate('Pagar boleto até 2026-12-05', BASE).cleaned, 'Pagar boleto');
  assert.equal(extractDate('Entregar até 15-10', BASE).date, '2026-10-15');
  assert.equal(extractDate('Entregar 15-10-2026', BASE).date, '2026-10-15');
});

test('"do mês que vem", ordinal "1º", "dia 31" em mês curto', () => {
  assert.equal(extractDate('Entregar até dia 5 do mês que vem', BASE).date, '2026-10-05');
  assert.equal(extractDate('Entregar até dia 5 do mês que vem', BASE).cleaned, 'Entregar');
  assert.equal(extractDate('Fechar caixa no final do mês que vem', BASE).date, '2026-10-31');
  assert.equal(extractDate('Enviar dia 1º', BASE).cleaned, 'Enviar');
  assert.equal(extractDate('Pagar 1º de outubro', BASE).date, '2026-10-01');
  assert.equal(extractDate('Pagar dia 31', BASE).date, '2026-10-31');
  assert.equal(extractDate('Pagar dia 30', '2026-02-10').date, '2026-03-30');
  assert.equal(extractDate('Ligar amanhã cedo', BASE).cleaned, 'Ligar');
});

test('isEnd distingue "até" de "a partir de"', () => {
  assert.equal(extractDate('Backup até 15/10', BASE).isEnd, true);
  assert.equal(extractDate('Backup a partir de 15/10', BASE).isEnd, false);
  assert.equal(extractDate('Backup 15/10', BASE).isEnd, false);
});

test('recorrência: dias úteis antes de "todo dia", listas de dias, vários dias do mês', () => {
  assert.deepEqual(extractRecurrence('Conferir e-mail todo dia útil').rule, { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
  assert.equal(extractRecurrence('Conferir e-mail todo dia útil').cleaned, 'Conferir e-mail');
  assert.deepEqual(extractRecurrence('Enviar relatório toda terça e quinta').rule, { freq: 'weekly', interval: 1, weekdays: [2, 4] });
  assert.equal(extractRecurrence('Enviar relatório toda terça e quinta').cleaned, 'Enviar relatório');
  assert.deepEqual(extractRecurrence('Reunião toda terça, quinta e sexta').rule.weekdays, [2, 4, 5]);
  assert.deepEqual(extractRecurrence('Reunião às segundas e quartas').rule.weekdays, [1, 3]);
  assert.deepEqual(extractRecurrence('Relatório todas as sextas').rule.weekdays, [5]);
  assert.deepEqual(extractRecurrence('Fechar planilha todo dia 15 e 30').rule, { freq: 'monthly', interval: 1, monthDays: [15, 30] });
  assert.equal(extractRecurrence('Fechar planilha todo dia 15 e 30').cleaned, 'Fechar planilha');
  assert.deepEqual(extractRecurrence('Limpar a cada 3 dias').rule, { freq: 'daily', interval: 3 });
  assert.equal(extractRecurrence('Casas e quartas').rule, null);
});
