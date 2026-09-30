import { Router } from 'express';
import { createTask, updateTask, deleteTask, getTask, listTasks, counts, weekView } from '../services/tasks.js';
import { getSettings, setSettings, listNotices, dismissNotice, DEFAULT_SETTINGS } from '../db/database.js';
import { today, mondayOf, isValidYmd } from '../services/dates.js';
import { extractDate, extractRecurrence } from '../services/dateParser.js';
import { parseDemand } from '../whatsapp/parser.js';
import * as wa from '../whatsapp/client.js';

export function apiRouter() {
  const r = Router();

  r.get('/health', (_req, res) => res.json({ ok: true, today: today(), whatsapp: wa.getStatus().status }));

  // ---------- tarefas ----------
  r.get('/tasks', (req, res) => {
    const view = String(req.query.view || 'today');
    res.json({ today: today(), counts: counts(), tasks: listTasks(view) });
  });

  // Visão semanal ("bloco"): ?start=YYYY-MM-DD (segunda-feira); padrão = semana atual
  r.get('/week', (req, res) => {
    const t = today();
    let start = String(req.query.start || '');
    if (!isValidYmd(start)) start = mondayOf(t);
    else start = mondayOf(start);
    res.json({ counts: counts(), ...weekView(start, t) });
  });

  r.get('/tasks/:id', (req, res) => {
    const t = getTask(Number(req.params.id));
    if (!t) return res.status(404).json({ error: 'Tarefa não encontrada' });
    res.json(t);
  });

  r.post('/tasks', (req, res) => {
    const body = req.body || {};
    // Atalho: se vier só "text", interpreta datas/recorrência em português
    if (body.text && !body.title) {
      const rec = extractRecurrence(String(body.text));
      const dt = extractDate(rec.cleaned);
      body.title = dt.cleaned || String(body.text);
      if (rec.rule) {
        // "até <data>" em recorrência é o fim da repetição; outra preposição é o início
        if (dt.date && dt.isEnd) body.recurrence = { ...rec.rule, until: dt.date };
        else { body.recurrence = rec.rule; if (dt.date) body.start_date = dt.date; }
      } else if (dt.date && !body.due_date) body.due_date = dt.date;
    }
    res.status(201).json(createTask(body));
  });

  r.patch('/tasks/:id', (req, res) => {
    const t = updateTask(Number(req.params.id), req.body || {});
    if (!t) return res.status(404).json({ error: 'Tarefa não encontrada' });
    res.json(t);
  });

  r.delete('/tasks/:id', (req, res) => {
    if (!deleteTask(Number(req.params.id))) return res.status(404).json({ error: 'Tarefa não encontrada' });
    res.status(204).end();
  });

  // Pré-visualização do parser (usado pela interface ao digitar)
  r.post('/parse', (req, res) => {
    const text = String(req.body?.text || '');
    if (req.body?.marker) return res.json(parseDemand(text, req.body.marker));
    const rec = extractRecurrence(text);
    const dt = extractDate(rec.cleaned);
    const isUntil = Boolean(rec.rule && dt.date && dt.isEnd);
    res.json({ title: dt.cleaned || text, date: dt.date, isEnd: dt.isEnd, recurrence: isUntil ? { ...rec.rule, until: dt.date } : rec.rule });
  });

  // ---------- configurações ----------
  r.get('/settings', (_req, res) => res.json({ settings: getSettings(), defaults: DEFAULT_SETTINGS }));
  r.put('/settings', (req, res) => {
    const settings = setSettings(req.body || {});
    const grupo = wa.listGroups().find((g) => g.jid === settings.wa_group_jid);
    console.log(JSON.stringify({ level: 30, time: Date.now(), mod: 'settings', msg: 'configurações salvas',
      grupo: settings.wa_group_jid ? `${grupo ? grupo.subject + ' ' : ''}${settings.wa_group_jid}` : '(nenhum)', marcador: settings.wa_marker }));
    res.json({ settings });
  });

  // ---------- avisos ----------
  r.get('/notices', (_req, res) => res.json(listNotices()));
  r.post('/notices/:id/dismiss', (req, res) => { dismissNotice(Number(req.params.id)); res.status(204).end(); });

  // ---------- whatsapp ----------
  r.get('/whatsapp/status', (_req, res) => res.json(wa.getStatus()));
  r.get('/whatsapp/groups', (_req, res) => res.json(wa.listGroups()));
  const waGuard = (res) => {
    if (wa.getStatus().enabled) return true;
    res.status(409).json({ error: 'WhatsApp desativado (WA_ENABLED=false no .env)' });
    return false;
  };
  r.post('/whatsapp/reconnect', async (_req, res) => {
    if (!waGuard(res)) return;
    try { await wa.reconnect(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post('/whatsapp/logout', async (_req, res) => {
    if (!waGuard(res)) return;
    try { await wa.logout(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
}
