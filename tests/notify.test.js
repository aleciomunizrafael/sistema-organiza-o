import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useMemoryDb, setSettings } from '../src/db/database.js';
import { createTask } from '../src/services/tasks.js';
import { reminderMessage, digestMessage, saveSubscription, countSubscriptions, notify } from '../src/services/notify.js';
import { buildDigest } from '../src/services/scheduler.js';
import { __test as wa } from '../src/whatsapp/client.js';

beforeEach(() => useMemoryDb());

test('mensagem de lembrete inclui prazo e prioridade', () => {
  const m = reminderMessage({ title: 'Ligar para o banco', due_date: '2026-10-03', priority: 1, notes: 'ramal 12' });
  assert.equal(m.title, 'Lembrete: Ligar para o banco');
  assert.match(m.text, /prazo 03\/10\/2026/);
  assert.match(m.text, /prioridade alta/);
  assert.match(m.text, /ramal 12/);
});

test('resumo diário lista atrasadas, hoje e as que entram hoje', () => {
  createTask({ title: 'Atrasada', due_date: '2020-01-01' });
  createTask({ title: 'Normal' });
  createTask({ title: 'Guardada', someday: true });
  const d = buildDigest();
  assert.match(d.text, /Atrasadas \(1\)/);
  assert.match(d.text, /• Atrasada \(venceu 01\/01\/2020\)/);
  assert.match(d.text, /• Normal/);
  assert.doesNotMatch(d.text, /Guardada/);
  const empty = digestMessage({ today: [], overdue: [], scheduledToday: [] });
  assert.match(empty.text, /Nada pendente/);
});

test('inscrições push: validação e contagem', () => {
  assert.throws(() => saveSubscription({ endpoint: 'x' }), /inválida/);
  saveSubscription({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } }, 'ua');
  saveSubscription({ endpoint: 'https://push.example/1', keys: { p256dh: 'a2', auth: 'b2' } }, 'ua');
  assert.equal(countSubscriptions(), 1);
});

test('notify envia pelo WhatsApp quando conectado e informa erro quando não', async () => {
  const sent = [];
  wa.state.status = 'connected';
  wa.state.me = { id: '5511888880000', name: 'Eu' };
  wa.setSock({ sendMessage: async (jid, content) => { sent.push({ jid, content }); } });
  setSettings({ notify_whatsapp: '1', notify_push: '0' });
  const r = await notify({ title: 'T', body: 'B', text: 'texto' });
  assert.equal(r.whatsapp, true);
  assert.equal(sent[0].jid, '5511888880000@s.whatsapp.net');
  assert.equal(sent[0].content.text, 'texto');
  wa.state.status = 'disconnected';
  const r2 = await notify({ title: 'T', text: 'x' });
  assert.equal(r2.whatsapp, false);
  assert.match(r2.errors[0], /WhatsApp/);
});
