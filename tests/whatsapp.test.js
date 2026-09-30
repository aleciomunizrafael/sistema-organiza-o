import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseDemand, extractMessageText } from '../src/whatsapp/parser.js';
import { useMemoryDb, setSettings, setState, getDb, listNotices } from '../src/db/database.js';
import { listTasks } from '../src/services/tasks.js';
import { __test as wa } from '../src/whatsapp/client.js';

const BASE = '2026-09-30';

test('parseDemand ignora mensagens sem marcador', () => {
  assert.equal(parseDemand('Bom dia pessoal', '#demanda', BASE), null);
  assert.equal(parseDemand('#demandas do mês', '#demanda', BASE), null);
});

test('parseDemand extrai título, prazo e prioridade', () => {
  const d = parseDemand('#demanda urgente Revisar contrato da Alfa até sexta', '#demanda', BASE);
  assert.equal(d.title, 'Revisar contrato da Alfa');
  assert.equal(d.due_date, '2026-10-02');
  assert.equal(d.priority, 1);
});

test('parseDemand aceita marcador no fim, maiúsculas e vários marcadores', () => {
  assert.equal(parseDemand('Ligar para o fornecedor #DEMANDA', '#demanda', BASE).title, 'Ligar para o fornecedor');
  assert.equal(parseDemand('!! Enviar NF', '#demanda, !!', BASE).title, 'Enviar NF');
});

test('parseDemand separa observações nas linhas seguintes', () => {
  const d = parseDemand('#demanda: Montar apresentação\nUsar o modelo novo\nEnviar para a diretoria', '#demanda', BASE);
  assert.equal(d.title, 'Montar apresentação');
  assert.equal(d.notes, 'Usar o modelo novo\nEnviar para a diretoria');
});

test('parseDemand reconhece recorrência', () => {
  const d = parseDemand('#demanda Fechar planilha todo dia 5', '#demanda', BASE);
  assert.equal(d.title, 'Fechar planilha');
  assert.deepEqual(d.recurrence, { freq: 'monthly', interval: 1, monthDay: 5 });
  assert.equal(d.due_date, null);
});

test('extractMessageText cobre formatos comuns', () => {
  assert.equal(extractMessageText({ conversation: 'oi' }), 'oi');
  assert.equal(extractMessageText({ extendedTextMessage: { text: 'oi 2' } }), 'oi 2');
  assert.equal(extractMessageText({ imageMessage: { caption: 'legenda' } }), 'legenda');
  assert.equal(extractMessageText({ ephemeralMessage: { message: { conversation: 'temp' } } }), 'temp');
  assert.equal(extractMessageText({ audioMessage: {} }), '');
});

// ---------- fluxo completo do handler ----------

function msg({ id, text, jid = 'grupo@g.us', fromMe = false, ts = Math.floor(Date.now() / 1000), name = 'Chefe' }) {
  return {
    key: { id, remoteJid: jid, fromMe, participant: '5511999990000@s.whatsapp.net' },
    message: { conversation: text },
    messageTimestamp: ts,
    pushName: name,
  };
}

beforeEach(() => {
  useMemoryDb();
  setSettings({ wa_group_jid: 'grupo@g.us', wa_marker: '#demanda', wa_reply_enabled: '1' });
  setState('wa_first_connected_at', String(Date.now() - 60_000));
  wa.state.me = { id: '5511888880000', name: 'Eu' };
  wa.state.stats = { received: 0, demands: 0, duplicates: 0, ignored: 0 };
});

test('cria tarefa a partir do grupo e responde citando a mensagem', () => {
  const sent = [];
  wa.setSock({ sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); } });
  wa.handleMessage(msg({ id: 'M1', text: '#demanda Enviar relatório até sexta' }));
  const tasks = listTasks('all');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Enviar relatório');
  assert.equal(tasks[0].source, 'whatsapp');
  assert.match(tasks[0].source_sender, /Chefe/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, 'grupo@g.us');
  assert.match(sent[0].content.text, /Anotado: Enviar relatório/);
  assert.match(sent[0].content.text, /prazo 02\/10\/2026/);
  assert.equal(sent[0].opts.quoted.key.id, 'M1');
});

test('mensagem reenviada após reconexão não duplica', () => {
  wa.setSock({ sendMessage: async () => {} });
  const m = msg({ id: 'M2', text: '#demanda Pagar boleto' });
  wa.handleMessage(m);
  wa.handleMessage(m);
  assert.equal(listTasks('all').length, 1);
  assert.equal(wa.state.stats.duplicates, 1);
});

test('ignora outros grupos e mensagens sem marcador', () => {
  wa.setSock({ sendMessage: async () => {} });
  wa.handleMessage(msg({ id: 'M3', text: '#demanda Outro grupo', jid: 'outro@g.us' }));
  wa.handleMessage(msg({ id: 'M4', text: 'Bom dia' }));
  assert.equal(listTasks('all').length, 0);
  assert.equal(wa.state.stats.ignored, 2);
});

test('ignora mensagens anteriores ao primeiro pareamento', () => {
  wa.setSock({ sendMessage: async () => {} });
  wa.handleMessage(msg({ id: 'M5', text: '#demanda Antiga', ts: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(listTasks('all').length, 0);
});

test('filtro de remetentes permitidos', () => {
  wa.setSock({ sendMessage: async () => {} });
  setSettings({ wa_allowed_senders: 'Maria, 5511999990000' });
  wa.handleMessage(msg({ id: 'M6', text: '#demanda Do número permitido', name: 'Alguém' }));
  setSettings({ wa_allowed_senders: 'Maria' });
  wa.handleMessage(msg({ id: 'M7', text: '#demanda Bloqueada', name: 'João' }));
  wa.handleMessage(msg({ id: 'M8', text: '#demanda Liberada', name: 'Maria Silva' }));
  const titles = listTasks('all').map((t) => t.title).sort();
  assert.deepEqual(titles, ['Do número permitido', 'Liberada']);
});

test('registro em wa_messages liga a mensagem à tarefa', () => {
  wa.setSock({ sendMessage: async () => {} });
  wa.handleMessage(msg({ id: 'M9', text: '#demanda Rastreável' }));
  const row = getDb().prepare('SELECT * FROM wa_messages WHERE message_id = ?').get('M9');
  assert.ok(row);
  assert.equal(row.task_id, listTasks('all')[0].id);
  assert.equal(listNotices().length, 0);
});
