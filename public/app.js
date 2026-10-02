/* Organiza — interface (vanilla JS) */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const VIEW_TITLES = {
    home: 'Organiza', today: 'Hoje', scheduled: 'Agendadas', all: 'Todas',
    completed: 'Concluídas', templates: 'Recorrentes', settings: 'Configurações', week: 'Bloco da semana', someday: 'Sem data',
  };
  const WEEKDAYS_LONG = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const WEEKDAYS_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

  const state = { view: 'home', today: null, counts: {}, tasks: [], settings: null, wa: null, editing: null, weekStart: null, week: null };
  let refreshTimer = null;

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.login) {
      location.replace('/login?next=' + encodeURIComponent(location.pathname + location.hash));
      throw new Error('Faça login para continuar');
    }
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  function toast(msg, ms = 2200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---------- datas ----------
  function todayYmd() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    const p = (x) => String(x).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  function fmtDate(ymd, withWeekday = true) {
    if (!ymd) return '';
    const t = state.today || todayYmd();
    if (ymd === t) return 'hoje';
    if (ymd === addDays(t, 1)) return 'amanhã';
    if (ymd === addDays(t, -1)) return 'ontem';
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const base = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}` + (y !== new Date().getFullYear() ? `/${y}` : '');
    return withWeekday ? `${WEEKDAYS_SHORT[dt.getDay()]} ${base}` : base;
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ---------- navegação ----------
  function show(view) {
    state.view = view;
    if (view === 'settings') state.settingsLoaded = false;
    $('#page-title').textContent = VIEW_TITLES[view] || 'Organiza';
    $('#view-home').classList.toggle('hidden', view !== 'home');
    $('#view-settings').classList.toggle('hidden', view !== 'settings');
    $('#view-week').classList.toggle('hidden', view !== 'week');
    document.body.classList.toggle('wide', view === 'week');
    $('#view-list').classList.toggle('hidden', !['today', 'scheduled', 'all', 'completed', 'templates', 'someday'].includes(view));
    $('#btn-home').style.visibility = view === 'home' ? 'hidden' : 'visible';
    $('#fab').classList.toggle('hidden', view === 'settings');
    history.replaceState(null, '', view === 'home' ? '#' : `#${view}`);
    refresh();
    startAutoRefresh();
  }

  let refreshSeq = 0;
  async function refresh() {
    const seq = ++refreshSeq;
    const stale = () => seq !== refreshSeq;
    try {
      await loadNotices();
      await loadWaBanner();
      if (stale()) return;
      if (state.view === 'settings') {
        if (!state.settingsLoaded) { await loadSettings(); state.settingsLoaded = true; }
        await loadWa();
        return;
      }
      if (state.view === 'week') {
        const q = state.weekStart ? `?start=${state.weekStart}` : '';
        const w = await api('GET', `/api/week${q}`);
        if (stale()) return;
        state.today = w.today;
        state.counts = w.counts;
        state.week = w;
        state.weekStart = w.start;
        renderCounts();
        renderWeek();
        return;
      }
      const view = state.view === 'home' ? 'today' : state.view;
      const data = await api('GET', `/api/tasks?view=${view}`);
      if (stale()) return;
      state.today = data.today;
      state.counts = data.counts;
      state.tasks = data.tasks;
      renderCounts();
      if (state.view !== 'home') renderList();
    } catch (e) {
      toast(e.message);
    }
  }

  function renderCounts() {
    const c = state.counts;
    $('#count-today').textContent = c.today ?? 0;
    $('#count-scheduled').textContent = c.scheduled ?? 0;
    $('#count-all').textContent = c.all ?? 0;
    $('#count-completed').textContent = c.completed ?? 0;
    $('#count-templates').textContent = c.templates ?? 0;
    $('#count-someday').textContent = c.someday ?? 0;
  }

  // ---------- lista ----------
  function renderList() {
    const ul = $('#task-list');
    const empty = $('#list-empty');
    const summary = $('#list-summary');
    ul.innerHTML = '';
    summary.textContent = '';

    if (!state.tasks.length) {
      empty.textContent = {
        today: 'Nada para hoje.', scheduled: 'Nenhuma tarefa agendada.', all: 'Nenhuma tarefa pendente.',
        completed: 'Nenhuma tarefa concluída ainda.', templates: 'Nenhuma tarefa recorrente.',
        someday: 'Nada guardado para "algum dia".',
      }[state.view] || 'Nada aqui.';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    if (state.view === 'today') {
      const overdue = state.tasks.filter((t) => t.due_date && t.due_date < state.today).length;
      summary.textContent = overdue ? `${overdue} atrasada${overdue > 1 ? 's' : ''}` : '';
    }

    // Agrupamento por data em Agendadas
    let lastGroup = null;
    for (const t of state.tasks) {
      if (state.view === 'scheduled') {
        const g = fmtDate(t.start_date);
        if (g !== lastGroup) {
          const h = document.createElement('li');
          h.className = 'section-title';
          h.textContent = g;
          ul.appendChild(h);
          lastGroup = g;
        }
      }
      ul.appendChild(renderTask(t));
    }
  }

  function renderTask(t) {
    const li = document.createElement('li');
    li.className = 'task' + (t.completed_at ? ' completed' : '');
    li.dataset.id = t.id;

    const check = document.createElement('button');
    check.className = 'tick' + (t.completed_at ? ' done' : '') + (t.priority ? ' high' : '');
    check.title = t.is_template ? (t.completed_at ? 'Reativar' : 'Pausar recorrência') : (t.completed_at ? 'Reabrir' : 'Concluir');
    check.innerHTML = t.completed_at ? '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5 10 17l9-10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' : (t.is_template ? '↻' : '');
    if (t.is_template) check.style.fontSize = '12px';
    check.addEventListener('click', (e) => { e.stopPropagation(); toggleComplete(t); });

    const main = document.createElement('div');
    main.className = 'task-main';
    main.addEventListener('click', () => openEditor(t));

    const title = document.createElement('div');
    title.className = 'task-title';
    if (t.priority) {
      const p = document.createElement('span'); p.className = 'prio'; p.textContent = '!'; title.appendChild(p);
    }
    title.appendChild(document.createTextNode(t.title));
    main.appendChild(title);

    if (t.notes) {
      const n = document.createElement('div');
      n.className = 'task-notes';
      n.textContent = t.notes.length > 160 ? t.notes.slice(0, 160) + '…' : t.notes;
      main.appendChild(n);
    }

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    const add = (text, cls = '') => {
      const s = document.createElement('span'); s.className = 'badge ' + cls; s.textContent = text; meta.appendChild(s);
    };

    if (t.is_template) {
      add('↻ ' + t.recurrence_label);
      if (t.completed_at) add('pausada');
      else if (t.next_date) add('próxima: ' + fmtDate(t.next_date));
    } else {
      if (t.due_date) {
        const cls = t.completed_at ? '' : t.due_date < state.today ? 'overdue' : t.due_date === state.today ? 'today' : '';
        add((cls === 'overdue' ? 'venceu ' : 'até ') + fmtDate(t.due_date), cls);
      }
      if (t.start_date && t.start_date > state.today) add('entra ' + fmtDate(t.start_date));
      if (t.template_id) add('↻ recorrente');
      if (t.someday) add(t.trigger_text ? 'quando ' + t.trigger_text.replace(/^quando\s+/i, '') : 'sem data');
      if (t.remind_at && !t.completed_at) add('lembrete ' + fmtDate(t.remind_at.slice(0, 10), false) + ' ' + t.remind_at.slice(11), t.reminded_at ? '' : 'today');
      if (t.completed_at) add('concluída ' + fmtDateTime(t.completed_at));
    }
    if (t.source === 'whatsapp') add('WhatsApp' + (t.source_sender ? ' · ' + t.source_sender.replace(/\s*\(\d+\)$/, '') : ''), 'wa');
    if (meta.children.length) main.appendChild(meta);

    const open = document.createElement('button');
    open.className = 'task-open';
    open.textContent = '›';
    open.setAttribute('aria-label', 'Detalhes');
    open.addEventListener('click', () => openEditor(t));

    li.append(check, main, open);
    return li;
  }

  async function toggleComplete(t) {
    try {
      await api('PATCH', `/api/tasks/${t.id}`, { completed: !t.completed_at });
      toast(t.is_template ? (t.completed_at ? 'Recorrência reativada' : 'Recorrência pausada') : (t.completed_at ? 'Tarefa reaberta' : 'Concluída ✓'));
      refresh();
    } catch (e) { toast(e.message); }
  }

  // ---------- adição rápida ----------
  let previewTimer = null;
  $('#quick-input').addEventListener('input', () => {
    clearTimeout(previewTimer);
    const text = $('#quick-input').value.trim();
    if (!text) { $('#quick-preview').textContent = ''; return; }
    previewTimer = setTimeout(async () => {
      try {
        const p = await api('POST', '/api/parse', { text });
        const parts = [];
        if (p.recurrence) parts.push('↻ ' + describeRule(p.recurrence) + (p.date && !p.recurrence.until ? ' a partir de ' + fmtDate(p.date) : ''));
        else if (p.date) parts.push('prazo ' + fmtDate(p.date));
        if (p.recurrence?.until) parts.push('até ' + fmtDate(p.recurrence.until));
        $('#quick-preview').textContent = parts.length ? `"${p.title || text}" — ${parts.join(', ')}` : '';
      } catch { /* ignore */ }
    }, 250);
  });
  async function quickAdd() {
    const text = $('#quick-input').value.trim();
    if (!text) return;
    try {
      await api('POST', '/api/tasks', { text });
      $('#quick-input').value = '';
      $('#quick-preview').textContent = '';
      toast('Tarefa adicionada');
      refresh();
    } catch (e) { toast(e.message); }
  }
  $('#quick-add-btn').addEventListener('click', quickAdd);
  $('#quick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(); });

  function describeRule(rule) {
    if (!rule) return '';
    const n = rule.interval || 1;
    switch (rule.freq) {
      case 'daily': return n === 1 ? 'todos os dias' : `a cada ${n} dias`;
      case 'weekly': {
        const wd = rule.weekdays || [];
        if (n === 1 && wd.length === 5 && [1, 2, 3, 4, 5].every((x) => wd.includes(x))) return 'dias úteis';
        const days = wd.length ? ' (' + wd.map((x) => WEEKDAYS_SHORT[x]).join(', ') + ')' : '';
        return (n === 1 ? 'toda semana' : `a cada ${n} semanas`) + days;
      }
      case 'monthly': return (n === 1 ? 'todo mês' : `a cada ${n} meses`) + (rule.monthDays ? ` dias ${rule.monthDays.join(', ')}` : rule.monthDay ? ` dia ${rule.monthDay}` : '');
      case 'yearly': return n === 1 ? 'todo ano' : `a cada ${n} anos`;
      default: return '';
    }
  }

  // ---------- editor ----------
  const sheet = $('#sheet');
  function openEditor(task, preset = {}) {
    state.editing = task || null;
    $('#sheet-title').textContent = task ? (task.is_template ? 'Tarefa recorrente' : 'Tarefa') : 'Nova tarefa';
    $('#f-id').value = task?.id || '';
    $('#f-title').value = task?.title || '';
    $('#f-notes').value = task?.notes || '';
    $('#f-start').value = task?.start_date || preset.start_date || '';
    $('#f-due').value = task?.due_date || preset.due_date || '';
    $('#f-priority').checked = Boolean(task?.priority);
    $('#f-trigger').value = task?.trigger_text || preset.trigger_text || '';
    $('#f-remind').value = task?.remind_at || '';
    $('#f-delete').classList.toggle('hidden', !task);
    setMode(task ? (task.someday ? 'someday' : 'todo') : (preset.someday ? 'someday' : 'todo'));
    // modo só faz sentido para tarefas comuns (não recorrentes)
    $('#f-mode').classList.toggle('hidden', Boolean(task?.is_template || task?.template_id));
    // ocorrência de recorrência: a repetição é editada no modelo (Recorrentes), não aqui
    $('#f-repeat-wrap').classList.toggle('hidden', Boolean(task?.template_id));
    if (task?.template_id) { $('#f-custom').classList.add('hidden'); $('#f-until-wrap').classList.add('hidden'); }

    // recorrência
    const rule = task?.recurrence || null;
    setRepeatFromRule(rule);
    $('#f-until').value = rule?.until || '';

    // origem
    const src = $('#f-source');
    if (task?.source === 'whatsapp') {
      src.innerHTML = '';
      const s = document.createElement('div');
      s.innerHTML = `<strong>Recebida pelo WhatsApp</strong>` + (task.source_sender ? ` de ${escapeHtml(task.source_sender)}` : '')
        + (task.source_timestamp ? ` em ${fmtDateTime(task.source_timestamp)}` : '') + `\n\n${escapeHtml(task.source_text || '')}`;
      src.appendChild(s);
      src.classList.remove('hidden');
    } else if (task?.template_id) {
      src.textContent = 'Ocorrência de uma tarefa recorrente. Para alterar a repetição, edite em Recorrentes.';
      src.classList.remove('hidden');
    } else {
      src.classList.add('hidden');
    }

    updateRepeatUi();
    sheet.classList.remove('hidden');
    if (!task) setTimeout(() => $('#f-title').focus(), 50);
  }
  function closeEditor() { sheet.classList.add('hidden'); state.editing = null; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setRepeatFromRule(rule) {
    const sel = $('#f-repeat');
    $$('#f-weekdays input').forEach((c) => { c.checked = false; });
    $('#f-interval').value = 1;
    $('#f-monthday').value = '';
    if (!rule) { sel.value = ''; return; }
    const wd = rule.weekdays || [];
    const n = rule.interval || 1;
    const isWeekdays = rule.freq === 'weekly' && n === 1 && wd.length === 5 && [1, 2, 3, 4, 5].every((x) => wd.includes(x));
    if (rule.freq === 'daily' && n === 1) sel.value = 'daily';
    else if (isWeekdays) sel.value = 'weekdays';
    else if (rule.freq === 'weekly' && n === 1 && !wd.length) sel.value = 'weekly';
    else if (rule.freq === 'weekly' && n === 2 && !wd.length) sel.value = 'biweekly';
    else if (rule.freq === 'monthly' && n === 1 && !rule.monthDay && !rule.monthDays) sel.value = 'monthly';
    else if (rule.freq === 'yearly' && n === 1) sel.value = 'yearly';
    else {
      sel.value = 'custom';
      $('#f-freq').value = rule.freq;
      $('#f-interval').value = n;
      $$('#f-weekdays input').forEach((c) => { c.checked = wd.includes(Number(c.value)); });
      if (rule.monthDays && rule.monthDays.length) $('#f-monthday').value = rule.monthDays.join(', ');
      else if (rule.monthDay) $('#f-monthday').value = rule.monthDay;
    }
  }

  function currentMode() {
    return $('#f-mode button.active')?.dataset.mode || 'todo';
  }
  function isOccurrenceEdit() { return Boolean(state.editing?.template_id); }
  function setMode(mode) {
    $$('#f-mode button').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const someday = mode === 'someday';
    $('#f-trigger-wrap').classList.toggle('hidden', !someday);
    $('#f-dates').classList.toggle('hidden', someday);
    $('#f-repeat-wrap').classList.toggle('hidden', someday || isOccurrenceEdit());
    if (someday || isOccurrenceEdit()) { $('#f-custom').classList.add('hidden'); $('#f-until-wrap').classList.add('hidden'); }
    else updateRepeatUi();
  }
  $$('#f-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  function updateRepeatUi() {
    if (currentMode() === 'someday') return;
    const v = $('#f-repeat').value;
    const isTemplateEdit = Boolean(state.editing?.is_template);
    $('#f-custom').classList.toggle('hidden', v !== 'custom');
    $('#f-until-wrap').classList.toggle('hidden', !v);
    $('#f-due-wrap').classList.toggle('hidden', Boolean(v) || isTemplateEdit);
    $('#f-weekdays').classList.toggle('hidden', $('#f-freq').value !== 'weekly');
    $('#f-monthday-wrap').classList.toggle('hidden', $('#f-freq').value !== 'monthly');
    $('#f-start').parentElement.firstChild.textContent = v ? 'Começa em' : 'Entrar na lista em';
  }
  $('#f-repeat').addEventListener('change', updateRepeatUi);
  $('#f-freq').addEventListener('change', updateRepeatUi);

  function ruleFromForm() {
    const v = $('#f-repeat').value;
    if (!v) return null;
    let rule;
    if (v === 'custom') {
      rule = { freq: $('#f-freq').value, interval: Math.max(1, parseInt($('#f-interval').value, 10) || 1) };
      if (rule.freq === 'weekly') {
        const wd = $$('#f-weekdays input:checked').map((c) => Number(c.value));
        if (wd.length) rule.weekdays = wd;
      }
      if (rule.freq === 'monthly' && $('#f-monthday').value.trim()) {
        const days = [...new Set($('#f-monthday').value.split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 31))];
        if (days.length === 1) rule.monthDay = days[0];
        else if (days.length > 1) rule.monthDays = days;
      }
    } else {
      rule = v; // preset
    }
    const until = $('#f-until').value;
    if (until) {
      if (typeof rule === 'string') rule = { preset: rule };
      rule.until = until;
    }
    return rule;
  }

  async function saveEditor() {
    const id = $('#f-id').value;
    let recurrence = ruleFromForm();
    if (recurrence && recurrence.preset) {
      // expande preset para objeto quando houver "until"
      const presets = {
        daily: { freq: 'daily', interval: 1 }, weekdays: { freq: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] },
        weekly: { freq: 'weekly', interval: 1 }, biweekly: { freq: 'weekly', interval: 2 },
        monthly: { freq: 'monthly', interval: 1 }, yearly: { freq: 'yearly', interval: 1 },
      };
      recurrence = { ...presets[recurrence.preset], until: recurrence.until };
    }
    const someday = currentMode() === 'someday' && !state.editing?.is_template && !state.editing?.template_id;
    if (recurrence && !$('#f-start').value) $('#f-start').value = state.today || todayYmd();
    const body = someday ? {
      title: $('#f-title').value,
      notes: $('#f-notes').value,
      priority: $('#f-priority').checked,
      someday: true,
      trigger_text: $('#f-trigger').value,
      remind_at: $('#f-remind').value || null,
      start_date: null,
      due_date: null,
      recurrence: null,
    } : {
      title: $('#f-title').value,
      notes: $('#f-notes').value,
      start_date: $('#f-start').value || null,
      due_date: recurrence ? null : ($('#f-due').value || null),
      priority: $('#f-priority').checked,
      recurrence,
      someday: false,
      trigger_text: '',
      remind_at: $('#f-remind').value || null,
    };
    if (!body.title.trim()) { toast('Informe um título'); return; }
    try {
      if (id) await api('PATCH', `/api/tasks/${id}`, body);
      else await api('POST', '/api/tasks', body);
      closeEditor();
      toast(id ? 'Salvo' : 'Tarefa criada');
      refresh();
    } catch (e) { toast(e.message); }
  }

  async function deleteEditing() {
    const id = $('#f-id').value;
    if (!id) return;
    const t = state.editing;
    const msg = t?.is_template ? 'Excluir esta recorrência e todas as suas ocorrências?' : 'Excluir esta tarefa?';
    if (!confirm(msg)) return;
    try {
      await api('DELETE', `/api/tasks/${id}`);
      closeEditor();
      toast('Excluída');
      refresh();
    } catch (e) { toast(e.message); }
  }

  $('#sheet-cancel').addEventListener('click', closeEditor);
  $('.sheet-backdrop').addEventListener('click', closeEditor);
  $('#sheet-save').addEventListener('click', saveEditor);
  $('#task-form').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
  $('#f-delete').addEventListener('click', deleteEditing);
  $('#fab').addEventListener('click', () => openEditor(null));


  // ---------- bloco da semana ----------
  function mondayOf(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const back = (dt.getDay() + 6) % 7;
    return addDays(ymd, -back);
  }
  function fmtDayMonth(ymd) {
    const [, m, d] = ymd.split('-').map(Number);
    return `${d} ${MONTHS_SHORT[m - 1]}`;
  }

  function renderWeek() {
    const w = state.week;
    if (!w) return;
    const body = $('#week-body');
    const main = $('#undated-body');
    const some = $('#someday-body');
    body.innerHTML = '';
    main.innerHTML = '';
    some.innerHTML = '';

    const [sy] = w.start.split('-');
    const [ey] = w.end.split('-');
    const isCurrent = w.today >= w.start && w.today <= w.end;
    $('#week-label').textContent = `${fmtDayMonth(w.start)} – ${fmtDayMonth(w.end)}${sy !== ey || sy !== String(new Date().getFullYear()) ? ' ' + ey : ''}`;
    $('#week-today').classList.toggle('hidden', isCurrent);

    const section = (parent, title, cls = '') => {
      const h = document.createElement('div');
      h.className = 'paper-section ' + cls;
      h.textContent = title;
      parent.appendChild(h);
      return h;
    };
    const emptyLine = (parent, text = '—') => {
      const e = document.createElement('div');
      e.className = 'paper-empty';
      e.textContent = text;
      parent.appendChild(e);
    };

    // ----- folha principal: a fazer -----
    const h = section(main, 'A fazer', 'undated');
    const count = document.createElement('span');
    count.className = 'paper-count';
    count.textContent = w.undated.length;
    h.appendChild(count);
    if (!w.undated.length) emptyLine(main, 'nada pendente');
    else {
      const items = document.createElement('div');
      items.className = 'paper-items';
      for (const t of w.undated) items.appendChild(renderPaperItem(t));
      main.appendChild(items);
    }
    main.appendChild(renderAddLine());

    // ----- folha secundária: sem data (algum dia) -----
    const hs = section(some, 'Sem data', 'someday');
    const cs = document.createElement('span');
    cs.className = 'paper-count';
    cs.textContent = (w.someday || []).length;
    hs.appendChild(cs);
    if (!(w.someday || []).length) emptyLine(some, 'nada guardado');
    else {
      const items = document.createElement('div');
      items.className = 'paper-items';
      for (const t of w.someday || []) items.appendChild(renderPaperItem(t));
      some.appendChild(items);
    }
    some.appendChild(renderAddLine({ someday: true }));

    // ----- folha da semana -----
    if (w.overdue.length) {
      section(body, 'Atrasadas', 'overdue');
      for (const t of w.overdue) body.appendChild(renderPaperItem(t, { showDate: true }));
    }

    for (const day of w.days) {
      const [, , d] = day.date.split('-').map(Number);
      const wd = new Date(...day.date.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x)))).getDay();
      const isToday = day.date === w.today;
      const hd = section(body, `${WEEKDAYS_LONG[wd]}, ${d}`, 'day' + (isToday ? ' today' : '') + (day.date < w.today ? ' past' : ''));
      if (isToday) {
        const tag = document.createElement('span');
        tag.className = 'today-tag';
        tag.textContent = 'hoje';
        hd.appendChild(tag);
      }
      const add = document.createElement('button');
      add.className = 'paper-add';
      add.title = 'Nova tarefa neste dia';
      add.textContent = '+';
      add.addEventListener('click', () => openEditor(null, { due_date: day.date }));
      hd.appendChild(add);

      if (!day.tasks.length) emptyLine(body);
      for (const t of day.tasks) body.appendChild(renderPaperItem(t));
    }
  }

  // Linha de escrita no fim de cada folha: digitar + Enter cria a demanda.
  // Na folha "Sem data", um "quando ..." no texto vira a condição: "Comprar papel quando o papel acabar".
  function renderAddLine(opts = {}) {
    const li = document.createElement('div');
    li.className = 'paper-item paper-add-line';
    const tick = document.createElement('span');
    tick.className = 'tick ghost';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = opts.placeholder || '';
    input.setAttribute('aria-label', opts.someday ? 'Nova tarefa sem data' : 'Nova demanda');
    input.autocomplete = 'off';
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      try {
        let t;
        if (opts.someday) {
          const m = text.match(/^(.*?)[\s,;:–—-]+quando\s+(.+)$/i);
          const body = m ? { title: m[1].trim(), trigger_text: 'quando ' + m[2].trim() } : { title: text };
          t = await api('POST', '/api/tasks', { ...body, someday: true });
          toast(`Guardado: ${t.title}${t.trigger_text ? ` (${t.trigger_text})` : ''}`);
        } else {
          t = await api('POST', '/api/tasks', { text });
          const extra = t.due_date ? ` (prazo ${fmtDate(t.due_date)})` : t.recurrence_label ? ` (${t.recurrence_label.toLowerCase()})` : '';
          toast(`Anotado: ${t.title}${extra}`);
        }
        input.value = '';
        await refresh();
        $(opts.someday ? '#someday-body input' : '#undated-body input')?.focus();
      } catch (err) {
        toast(err.message);
        input.disabled = false;
      }
    });
    li.append(tick, input);
    return li;
  }

  function renderPaperItem(t, opts = {}) {
    const li = document.createElement('div');
    li.className = 'paper-item' + (t.completed_at ? ' completed' : '') + (t.virtual ? ' virtual' : '');

    const tick = document.createElement('button');
    tick.className = 'tick' + (t.completed_at ? ' done' : '') + (t.priority ? ' high' : '');
    tick.innerHTML = t.completed_at
      ? '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12.5 10 17l9-10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '';
    if (t.virtual) {
      tick.title = 'Ocorrência prevista: entra na lista no dia';
      tick.addEventListener('click', () => toast('Ocorrência prevista. Ela entra na lista quando o dia chegar.'));
    } else {
      tick.title = t.completed_at ? 'Reabrir' : 'Concluir';
      tick.addEventListener('click', (e) => { e.stopPropagation(); toggleComplete(t); });
    }

    const main = document.createElement('div');
    main.className = 'paper-content';
    const title = document.createElement('span');
    title.className = 'paper-title';
    if (t.priority) {
      const p = document.createElement('span'); p.className = 'prio'; p.textContent = '!'; title.appendChild(p);
    }
    title.appendChild(document.createTextNode(t.title));
    main.appendChild(title);

    const meta = [];
    if (opts.showDate && t.due_date) meta.push('venceu ' + fmtDate(t.due_date));
    if (t.kind === 'scheduled') meta.push('entra na lista');
    if (t.kind === 'projected' || t.template_id) meta.push('↻' + (t.recurrence_label ? ' ' + t.recurrence_label.toLowerCase() : ''));
    if (t.someday && t.trigger_text) meta.push(t.trigger_text);
    else if (t.someday && t.kind === 'done') meta.push('sem data');
    if (t.source === 'whatsapp') meta.push('WhatsApp');
    if (t.notes) meta.push(t.notes.length > 60 ? t.notes.slice(0, 60) + '…' : t.notes);
    if (meta.length) {
      const m = document.createElement('span');
      m.className = 'paper-meta';
      m.textContent = meta.join(' · ');
      main.appendChild(m);
    }

    main.addEventListener('click', async () => {
      if (t.virtual) {
        try { openEditor(await api('GET', `/api/tasks/${t.template_id}`)); } catch (e) { toast(e.message); }
      } else {
        openEditor(t);
      }
    });

    li.append(tick, main);
    return li;
  }

  $('#week-prev').addEventListener('click', () => { state.weekStart = addDays(state.weekStart || mondayOf(todayYmd()), -7); refresh(); });
  $('#week-next').addEventListener('click', () => { state.weekStart = addDays(state.weekStart || mondayOf(todayYmd()), 7); refresh(); });
  $('#week-today').addEventListener('click', () => { state.weekStart = mondayOf(todayYmd()); refresh(); });

  // ---------- faixa do WhatsApp (bot fora do ar) ----------
  async function loadWaBanner() {
    if (state.view === 'settings') { $('#wa-banner')?.remove(); return; }
    let wa;
    try { wa = await api('GET', '/api/whatsapp/status'); } catch { return; }
    const bad = wa.enabled && !['connected', 'starting', 'connecting'].includes(wa.status);
    let el = $('#wa-banner');
    if (!bad) { el?.remove(); return; }
    const text = {
      qr: 'O bot do WhatsApp está aguardando a leitura do QR code.',
      logged_out: 'A sessão do WhatsApp foi encerrada. É preciso escanear o QR code de novo.',
      conflict: 'A sessão do WhatsApp está em uso por outra máquina.',
      disconnected: 'O bot do WhatsApp está desconectado e tentando reconectar.',
      error: 'O bot do WhatsApp encontrou um erro.',
    }[wa.status] || `Bot do WhatsApp: ${wa.status}.`;
    if (!el) {
      el = document.createElement('div');
      el.id = 'wa-banner';
      el.className = 'notice';
      const span = document.createElement('span');
      const btn = document.createElement('button');
      btn.textContent = 'Abrir';
      btn.addEventListener('click', () => show('settings'));
      el.append(span, btn);
      $('#notices').prepend(el);
    }
    el.firstChild.textContent = text;
  }

  // ---------- avisos ----------
  async function loadNotices() {
    const list = await api('GET', '/api/notices');
    const box = $('#notices');
    box.innerHTML = '';
    for (const n of list) {
      const el = document.createElement('div');
      el.className = 'notice';
      const span = document.createElement('span');
      span.textContent = n.message;
      const btn = document.createElement('button');
      btn.textContent = 'OK';
      btn.addEventListener('click', async () => { await api('POST', `/api/notices/${n.id}/dismiss`); el.remove(); });
      el.append(span, btn);
      box.appendChild(el);
    }
  }

  // ---------- tema ----------
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { if (t === 'light' || t === 'dark') localStorage.setItem('organiza-theme', t); else localStorage.removeItem('organiza-theme'); } catch { /* ignore */ }
  }
  $('#s-theme').addEventListener('change', () => applyTheme($('#s-theme').value));

  // ---------- calendário .ics ----------
  async function loadIcal() {
    try { const { url } = await api('GET', '/api/calendar/feed'); $('#ical-url').value = url; } catch { /* ignore */ }
  }
  $('#ical-copy').addEventListener('click', async () => {
    const v = $('#ical-url').value;
    try { await navigator.clipboard.writeText(v); toast('Endereço copiado'); }
    catch { $('#ical-url').select(); toast('Selecione e copie o endereço'); }
  });
  $('#ical-rotate').addEventListener('click', async () => {
    if (!confirm('Gerar um novo endereço? O antigo deixa de funcionar e será preciso assinar de novo no Google Agenda.')) return;
    try { const { url } = await api('POST', '/api/calendar/feed/rotate'); $('#ical-url').value = url; toast('Novo endereço gerado'); }
    catch (e) { toast(e.message); }
  });

  // ---------- notificações ----------
  async function refreshPushStatus() {
    const el = $('#push-status');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      el.textContent = 'Este navegador não suporta notificações do app.';
      $('#push-enable').disabled = true;
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const info = await api('GET', '/api/push/status');
      el.textContent = (sub ? 'Ativado neste aparelho. ' : 'Não ativado neste aparelho. ') + `${info.devices} aparelho(s) ativado(s) no total.`;
      $('#push-enable').textContent = sub ? 'Desativar neste aparelho' : 'Ativar notificações neste aparelho';
    } catch { el.textContent = ''; }
  }
  function b64ToU8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  $('#push-enable').addEventListener('click', async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await api('POST', '/api/push/unsubscribe', { endpoint: existing.endpoint });
        await existing.unsubscribe();
        toast('Notificações desativadas neste aparelho');
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Permissão de notificação negada'); return; }
        const { publicKey } = await api('GET', '/api/push/key');
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
        await api('POST', '/api/push/subscribe', sub.toJSON());
        toast('Notificações ativadas neste aparelho');
      }
    } catch (e) { toast(e.message); }
    refreshPushStatus();
    loadIcal();
  });
  $('#notify-test').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/notify/test');
      const parts = [];
      parts.push(r.whatsapp ? 'WhatsApp: enviado' : 'WhatsApp: não enviado');
      parts.push(`App: ${r.push} aparelho(s)`);
      if (r.errors?.length) parts.push(r.errors.join('; '));
      toast(parts.join(' · '), 5000);
    } catch (e) { toast(e.message); }
  });
  $('#s-save-notify').addEventListener('click', async () => {
    try {
      const days = $$('#s-digest-days input:checked').map((c) => c.value).join(',');
      const { settings } = await api('PUT', '/api/settings', {
        notify_whatsapp: $('#s-notify-wa').checked ? '1' : '0',
        notify_push: $('#s-notify-push').checked ? '1' : '0',
        digest_time: $('#s-digest-time').value || '',
        digest_days: days,
      });
      state.settings = settings;
      $('#s-saved-notify').textContent = 'Salvo ✓';
      setTimeout(() => { $('#s-saved-notify').textContent = ''; }, 2500);
    } catch (e) { toast(e.message); }
  });

  // ---------- sessão ----------
  api('GET', '/api/auth/status').then((a) => { $('#s-logout-wrap').classList.toggle('hidden', !a.enabled); }).catch(() => {});
  $('#s-logout').addEventListener('click', async () => {
    if (!confirm('Sair deste aparelho? Será preciso digitar a senha de novo.')) return;
    try { await api('POST', '/api/logout'); } catch { /* ignore */ }
    location.replace('/login');
  });

  // ---------- configurações ----------
  async function loadSettings() {
    let theme = 'auto';
    try { theme = localStorage.getItem('organiza-theme') || 'auto'; } catch { /* ignore */ }
    $('#s-theme').value = theme;
    const { settings } = await api('GET', '/api/settings');
    state.settings = settings;
    $('#s-marker').value = settings.wa_marker;
    $('#s-reply').checked = settings.wa_reply_enabled === '1';
    $('#s-reply-text').value = settings.wa_reply_text;
    $('#s-own').checked = settings.wa_accept_own === '1';
    $('#s-senders').value = settings.wa_allowed_senders;
    $('#s-offline').value = settings.wa_offline_alert_hours;
    $('#s-notify-wa').checked = settings.notify_whatsapp === '1';
    $('#s-notify-push').checked = settings.notify_push === '1';
    $('#s-digest-time').value = settings.digest_time || '';
    const days = (settings.digest_days || '').split(',');
    $$('#s-digest-days input').forEach((c) => { c.checked = days.includes(c.value); });
    refreshPushStatus();
    loadIcal();
  }

  async function loadWa() {
    const wa = await api('GET', '/api/whatsapp/status');
    state.wa = wa;
    const labels = {
      disabled: 'Desativado (WA_ENABLED=false)', starting: 'Iniciando…', qr: 'Aguardando leitura do QR code',
      connecting: 'Conectando…', connected: 'Conectado', disconnected: 'Desconectado, tentando reconectar…',
      logged_out: 'Sessão encerrada. Gere um novo QR code.', error: 'Erro: ' + (wa.lastError || ''),
      conflict: 'Sessão em uso por outra máquina. Desligue o bot lá e clique em Reconectar.',
    };
    $('#wa-dot').className = 'dot ' + wa.status;
    $('#wa-status-text').textContent = labels[wa.status] || wa.status;
    $('#wa-me').textContent = wa.me ? `Número: ${wa.me.id}${wa.me.name ? ' · ' + wa.me.name : ''}` : '';
    $('#wa-qr-wrap').classList.toggle('hidden', !(wa.status === 'qr' && wa.qr));
    if (wa.qr) $('#wa-qr').src = wa.qr;
    $('#wa-reconnect').disabled = wa.enabled === false;
    $('#wa-logout').disabled = wa.enabled === false || !['connected', 'connecting', 'disconnected', 'qr', 'conflict'].includes(wa.status);
    const s = wa.stats || {};
    $('#wa-stats').textContent = wa.status === 'connected'
      ? `Nesta sessão: ${s.received || 0} mensagens vistas, ${s.demands || 0} demandas criadas, ${s.duplicates || 0} duplicadas ignoradas.`
      : (wa.lastError && wa.status !== 'error' ? `Último erro: ${wa.lastError}` : '');

    // grupos: preserva o que o usuário escolheu (ainda não salvo) ao atualizar a lista
    const sel = $('#s-group');
    const saved = state.settings?.wa_group_jid || '';
    const chosen = sel.dataset.touched === '1' ? sel.value : saved;
    const groups = wa.groups || [];
    const signature = groups.map((g) => g.jid + g.subject + g.participants).join('|') + '#' + saved;
    if (sel.dataset.signature !== signature) {
      sel.dataset.signature = signature;
      sel.innerHTML = '';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = groups.length ? '— escolha o grupo —' : '— conecte o WhatsApp para listar —';
      sel.appendChild(opt0);
      for (const g of groups) {
        const o = document.createElement('option');
        o.value = g.jid;
        o.textContent = `${g.subject} (${g.participants})`;
        sel.appendChild(o);
      }
      for (const jid of new Set([saved, chosen])) {
        if (jid && !groups.some((g) => g.jid === jid)) {
          const o = document.createElement('option');
          o.value = jid;
          o.textContent = `${jid} (grupo configurado)`;
          sel.appendChild(o);
        }
      }
      sel.value = chosen;
    }
  }
  $('#s-group').addEventListener('change', () => { $('#s-group').dataset.touched = '1'; });

  $('#s-save').addEventListener('click', async () => {
    try {
      const body = {
        wa_group_jid: $('#s-group').value,
        wa_marker: $('#s-marker').value.trim() || '#demanda',
        wa_reply_enabled: $('#s-reply').checked ? '1' : '0',
        wa_reply_text: $('#s-reply-text').value.trim() || '✅ Anotado: {titulo}',
        wa_accept_own: $('#s-own').checked ? '1' : '0',
        wa_allowed_senders: $('#s-senders').value.trim(),
        wa_offline_alert_hours: String(Math.max(0, parseInt($('#s-offline').value, 10) || 0)),
      };
      if (!body.wa_group_jid && state.wa?.groups?.length) {
        toast('Escolha o grupo monitorado antes de salvar');
        return;
      }
      const { settings } = await api('PUT', '/api/settings', body);
      state.settings = settings;
      $('#s-group').dataset.touched = '';
      $('#s-saved').textContent = 'Salvo ✓';
      setTimeout(() => { $('#s-saved').textContent = ''; }, 2500);
      toast(settings.wa_group_jid ? 'Configurações salvas. Grupo monitorado definido.' : 'Configurações salvas');
      await loadSettings();
      await loadWa();
    } catch (e) { toast(e.message); }
  });
  $('#wa-reconnect').addEventListener('click', async () => {
    $('#wa-reconnect').disabled = true;
    try { await api('POST', '/api/whatsapp/reconnect'); toast('Reconectando…'); }
    catch (e) { toast(e.message); }
    finally { setTimeout(() => { $('#wa-reconnect').disabled = false; loadWa(); }, 1500); }
  });
  $('#wa-logout').addEventListener('click', async () => {
    if (!confirm('Encerrar a sessão do WhatsApp? Será preciso escanear o QR code novamente.')) return;
    try { await api('POST', '/api/whatsapp/logout'); toast('Sessão encerrada'); loadWa(); }
    catch (e) { toast(e.message); }
  });

  // ---------- eventos globais ----------
  $$('[data-view]').forEach((el) => el.addEventListener('click', () => show(el.dataset.view)));
  $('#btn-home').addEventListener('click', () => show('home'));
  $('#btn-settings').addEventListener('click', () => show('settings'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.classList.contains('hidden')) closeEditor(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  function startAutoRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.hidden || !sheet.classList.contains('hidden')) return;
      refresh();
    }, state.view === 'settings' ? 4000 : 30000);
  }
  // Service worker (PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  const initial = location.hash.replace('#', '');
  if (initial === 'new' || initial === 'new-someday') {
    show('home');
    openEditor(null, initial === 'new-someday' ? { someday: true } : {});
  } else {
    show(VIEW_TITLES[initial] ? initial : 'home');
  }
})();
