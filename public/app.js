/* Organiza — interface (vanilla JS) */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const VIEW_TITLES = {
    home: 'Organiza', today: 'Hoje', scheduled: 'Agendadas', all: 'Todas',
    completed: 'Concluídas', templates: 'Recorrentes', settings: 'Configurações', week: 'Bloco da semana', someday: 'Sem data', doing: 'Em andamento', leticia: 'Ver com Letícia',
  };
  const WEEKDAYS_LONG = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
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
    if (view === 'week' && state.view !== 'week') state.scrollToToday = true;
    state.view = view;
    if (view === 'settings') state.settingsLoaded = false;
    $('#page-title').textContent = VIEW_TITLES[view] || 'Organiza';
    $('#view-home').classList.toggle('hidden', view !== 'home');
    $('#view-settings').classList.toggle('hidden', view !== 'settings');
    $('#view-week').classList.toggle('hidden', view !== 'week');
    document.body.classList.toggle('wide', view === 'week');
    $('#view-list').classList.toggle('hidden', !['today', 'scheduled', 'all', 'completed', 'templates', 'someday', 'doing', 'leticia'].includes(view));
    $('#btn-home').style.visibility = view === 'home' ? 'hidden' : 'visible';
    $('#fab').classList.toggle('hidden', view === 'settings');
    history.replaceState(null, '', view === 'home' ? '#' : `#${view}`);
    refresh();
    startAutoRefresh();
  }

  let refreshSeq = 0;
  async function refresh() {
    if (drag.active) return;
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
        applyLabels(w.labels);
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
      applyLabels(data.labels);
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
    $('#count-doing').textContent = c.doing ?? 0;
    $('#count-leticia').textContent = c.leticia ?? 0;
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
        doing: 'Nada em andamento.', leticia: 'Nada para ver com ela.',
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
      if (t.status === 'doing') add('em andamento', 'today');
      if (t.status === 'leticia') add((state.leticiaLabel || 'Ver com Letícia').toLowerCase());
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
    $('#f-status').value = task?.status || preset.status || 'todo';
    $('#f-status-wrap').classList.toggle('hidden', Boolean(task?.is_template));
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
    $('#f-status-wrap').classList.toggle('hidden', someday || Boolean(state.editing?.is_template));
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
      ...(recurrence ? {} : { status: $('#f-status').value }),
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
    taskById.clear();

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

    // Folha que aceita arrastar: título, contador, itens (zona de soltar) e linha de escrita
    const sheet = (el, { title, cls, list, items, empty, addOpts }) => {
      el.innerHTML = '';
      const h = section(el, title, cls);
      const count = document.createElement('span');
      count.className = 'paper-count';
      count.textContent = items.length;
      h.appendChild(count);
      const box = document.createElement('div');
      box.className = 'paper-items';
      box.dataset.drop = list;
      if (!items.length) emptyLine(box, empty);
      for (const t of items) box.appendChild(renderPaperItem(t, { showDate: Boolean(t.due_date), inSheet: true }));
      el.appendChild(box);
      el.appendChild(renderAddLine(addOpts));
    };

    sheet($('#doing-body'), { title: 'Em andamento', cls: 'doing', list: 'doing', items: w.doing || [], empty: 'arraste para cá o que está fazendo', addOpts: { status: 'doing' } });
    sheet($('#leticia-body'), { title: state.leticiaLabel || 'Ver com Letícia', cls: 'leticia', list: 'leticia', items: w.leticia || [], empty: 'arraste para cá', addOpts: { status: 'leticia' } });
    sheet($('#undated-body'), { title: 'A fazer', cls: 'undated', list: 'todo', items: w.undated, empty: 'nada pendente', addOpts: {} });
    sheet($('#someday-body'), { title: 'Sem data', cls: 'someday', list: 'someday', items: w.someday || [], empty: 'nada guardado', addOpts: { someday: true } });

    // ----- folha da semana: cada dia é uma zona de soltar (muda o prazo) -----
    body.innerHTML = '';
    if (w.overdue.length) {
      section(body, 'Atrasadas', 'overdue');
      for (const t of w.overdue) body.appendChild(renderPaperItem(t, { showDate: true }));
    }

    // Na semana atual, os dias que já passaram ficam recolhidos numa linha (abre com um clique),
    // para a folha começar no dia de hoje.
    const isCurrentWeek = w.today >= w.start && w.today <= w.end;
    const pastDays = isCurrentWeek ? w.days.filter((d) => d.date < w.today) : [];
    let pastBox = null;
    if (pastDays.length) {
      let open = false;
      try { open = localStorage.getItem('organiza-past-open') === '1'; } catch { /* ignore */ }
      const pending = pastDays.reduce((n, d) => n + d.tasks.filter((t) => !t.completed_at && !t.virtual).length, 0);
      const names = pastDays.map((d) => WEEKDAYS_LONG[new Date(d.date + 'T12:00:00').getDay()].slice(0, 3)).join(', ');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'past-toggle';
      const label = () => `${open ? '▾' : '▸'} Dias anteriores: ${names}${pending ? ` · ${pending} em aberto` : ''}`;
      toggle.textContent = label();
      toggle.setAttribute('aria-expanded', String(open));
      body.appendChild(toggle);
      pastBox = document.createElement('div');
      pastBox.className = 'past-days' + (open ? '' : ' hidden');
      body.appendChild(pastBox);
      toggle.addEventListener('click', () => {
        open = !open;
        try { localStorage.setItem('organiza-past-open', open ? '1' : '0'); } catch { /* ignore */ }
        pastBox.classList.toggle('hidden', !open);
        toggle.textContent = label();
        toggle.setAttribute('aria-expanded', String(open));
      });
    }

    for (const day of w.days) {
      const [y, m, d] = day.date.split('-').map(Number);
      const wd = new Date(y, m - 1, d).getDay();
      const isToday = day.date === w.today;
      const isPast = day.date < w.today;
      const block = document.createElement('div');
      block.className = 'day-block' + (isToday ? ' today' : '') + (isPast ? ' past' : '');
      block.dataset.drop = 'day:' + day.date;
      (isPast && pastBox ? pastBox : body).appendChild(block);
      const title = isToday ? `${WEEKDAYS_LONG[wd]}, ${d} de ${MONTHS_LONG[m - 1]}` : `${WEEKDAYS_LONG[wd]}, ${d}`;
      const hd = section(block, title, 'day' + (isToday ? ' today' : '') + (isPast ? ' past' : ''));
      if (isToday) {
        const tag = document.createElement('span');
        tag.className = 'today-tag';
        tag.textContent = 'hoje';
        hd.prepend(tag);
      }
      const add = document.createElement('button');
      add.className = 'paper-add';
      add.title = 'Nova tarefa neste dia';
      add.textContent = '+';
      add.addEventListener('click', () => openEditor(null, { due_date: day.date }));
      hd.appendChild(add);

      const events = day.events || [];
      if (!day.tasks.length && !events.length) emptyLine(block, isToday ? 'nada marcado para hoje' : '—');
      for (const ev of events) block.appendChild(renderEventItem(ev));
      for (const t of day.tasks) block.appendChild(renderPaperItem(t));
    }

    if (state.scrollToToday) {
      state.scrollToToday = false;
      requestAnimationFrame(() => frameToday());
    }
  }

  // Coloca o dia de hoje no topo da coluna da semana (no computador, onde ela rola sozinha)
  function frameToday() {
    const el = document.querySelector('#week-body .day-block.today');
    const side = document.querySelector('.week-side');
    if (!side) return;
    if (!el) { side.scrollTop = 0; return; }
    const scrollable = side.scrollHeight > side.clientHeight + 4 && getComputedStyle(side).overflowY !== 'visible';
    if (!scrollable) return;
    const offset = el.getBoundingClientRect().top - side.getBoundingClientRect().top;
    const nav = side.querySelector('.week-nav');
    const keep = (nav ? nav.offsetHeight : 0) + 10;
    side.scrollTo({ top: Math.max(0, side.scrollTop + offset - keep), behavior: 'smooth' });
  }

  // ---------- arrastar e soltar (mouse; no celular, toque longo) ----------
  const taskById = new Map();
  const drag = { active: false, src: null, task: null, ghost: null, ph: null, zone: null, x: 0, y: 0, sx: 0, sy: 0, dx: 0, dy: 0, timer: null, pid: null, ptype: '', raf: 0, suppressClick: false };

  function makeDraggable(li, t) {
    li.dataset.id = t.id;
    li.classList.add('draggable');
    taskById.set(String(t.id), t);
    li.addEventListener('pointerdown', onDragPointerDown);
    li.addEventListener('contextmenu', (e) => { if (drag.src) e.preventDefault(); });
  }

  function onDragPointerDown(e) {
    if (drag.active || drag.src) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.tick, input, select, textarea, a, .paper-add')) return;
    const li = e.currentTarget;
    drag.src = li;
    drag.pid = e.pointerId;
    drag.ptype = e.pointerType;
    drag.sx = drag.x = e.clientX;
    drag.sy = drag.y = e.clientY;
    if (e.pointerType === 'mouse') e.preventDefault(); // evita selecionar texto ao arrastar
    else drag.timer = setTimeout(() => startDrag(), 380); // toque longo
    window.addEventListener('pointermove', onDragPointerMove, { passive: false });
    window.addEventListener('pointerup', onDragPointerUp);
    window.addEventListener('pointercancel', onDragPointerCancel);
  }

  function onDragPointerMove(e) {
    if (e.pointerId !== drag.pid) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.active) {
      const dist = Math.hypot(drag.x - drag.sx, drag.y - drag.sy);
      if (drag.ptype === 'mouse') { if (dist > 5) startDrag(); }
      else if (dist > 10) endDrag(false); // o dedo andou antes do toque longo: é rolagem
      return;
    }
    e.preventDefault();
    positionGhost();
    updateDropTarget();
  }

  function onDragPointerUp(e) {
    if (e.pointerId !== drag.pid) return;
    endDrag(drag.active);
  }

  function onDragPointerCancel(e) {
    if (e.pointerId !== drag.pid) return;
    endDrag(false);
  }

  function startDrag() {
    clearTimeout(drag.timer);
    const src = drag.src;
    if (!src || !src.isConnected) { endDrag(false); return; }
    drag.active = true;
    drag.task = taskById.get(src.dataset.id);
    const r = src.getBoundingClientRect();
    drag.dx = Math.min(drag.sx - r.left, 40);
    drag.dy = drag.sy - r.top;
    const ghost = src.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('draggable', 'drag-source');
    ghost.style.width = Math.min(r.width, 460) + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    const ph = document.createElement('div');
    ph.className = 'drop-ph';
    drag.ph = ph;
    src.classList.add('drag-source');
    document.body.classList.add('dragging');
    if (drag.ptype !== 'mouse' && navigator.vibrate) navigator.vibrate(15);
    positionGhost();
    updateDropTarget();
    autoScrollLoop();
  }

  function positionGhost() {
    if (drag.ghost) drag.ghost.style.transform = `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px) rotate(1.2deg)`;
  }

  function setZone(zone) {
    if (drag.zone === zone) return;
    drag.zone?.classList.remove('drop-over');
    drag.zone = zone;
    zone?.classList.add('drop-over');
  }

  function updateDropTarget() {
    const el = document.elementFromPoint(drag.x, drag.y);
    const zone = el ? el.closest('[data-drop]') : null;
    setZone(zone);
    if (!zone || zone.dataset.drop.startsWith('day:')) { drag.ph.remove(); return; }
    // Posição na folha: antes ou depois do item mais próximo do ponteiro (funciona com duas colunas)
    const items = [...zone.querySelectorAll(':scope > .paper-item[data-id]')].filter((i) => i !== drag.src);
    if (!items.length) { zone.appendChild(drag.ph); return; }
    let best = null;
    let bestD = Infinity;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      const cx = Math.max(r.left, Math.min(drag.x, r.right));
      const cy = Math.max(r.top, Math.min(drag.y, r.bottom));
      const d = Math.hypot(drag.x - cx, drag.y - cy);
      if (d < bestD) { bestD = d; best = it; }
    }
    const r = best.getBoundingClientRect();
    const ref = drag.y < r.top + r.height / 2 ? best : best.nextSibling;
    if (drag.ph.parentElement !== zone || drag.ph.nextSibling !== ref) zone.insertBefore(drag.ph, ref);
  }

  // Rola a página (ou a coluna da semana) quando o ponteiro chega perto da borda
  function autoScrollLoop() {
    cancelAnimationFrame(drag.raf);
    const step = () => {
      if (!drag.active) return;
      const edge = 70;
      let dy = 0;
      if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 5);
      else if (drag.y > window.innerHeight - edge) dy = Math.ceil((drag.y - (window.innerHeight - edge)) / 5);
      if (dy) {
        const side = drag.zone ? drag.zone.closest('.week-side') : null;
        if (side && side.scrollHeight > side.clientHeight) side.scrollTop += dy;
        else window.scrollBy(0, dy);
        updateDropTarget();
      }
      drag.raf = requestAnimationFrame(step);
    };
    drag.raf = requestAnimationFrame(step);
  }

  const LIST_NAMES = () => ({ todo: 'A fazer', doing: 'Em andamento', leticia: state.leticiaLabel || 'Ver com Letícia', someday: 'Sem data' });

  function endDrag(drop) {
    clearTimeout(drag.timer);
    cancelAnimationFrame(drag.raf);
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('pointercancel', onDragPointerCancel);
    const wasActive = drag.active;
    const { src, task, zone, ph } = drag;
    let action = null;
    if (wasActive && drop && zone && task) {
      const target = zone.dataset.drop;
      if (target.startsWith('day:')) {
        const date = target.slice(4);
        if (task.due_date !== date) action = { body: { due_date: date }, msg: `Prazo: ${fmtDate(date)}` };
      } else if (ph && ph.parentElement === zone) {
        const order = [...zone.children]
          .filter((c) => c === ph || (c.dataset && c.dataset.id && c !== src))
          .map((c) => (c === ph ? Number(task.id) : Number(c.dataset.id)));
        const fromList = src.parentElement && src.parentElement.dataset ? src.parentElement.dataset.drop : null;
        const sameList = fromList === target;
        const before = sameList ? [...zone.querySelectorAll(':scope > .paper-item[data-id]')].map((c) => Number(c.dataset.id)) : null;
        const unchanged = before && before.length === order.length && before.every((v, i) => v === order[i]);
        if (!unchanged) {
          if (target === 'someday' && (task.due_date || task.template_id)) {
            toast('Tarefas com prazo ou recorrentes não vão para "Sem data". Tire o prazo antes.', 4500);
          } else {
            let msg = '';
            if (!sameList) {
              msg = `Movida para ${LIST_NAMES()[target]}`;
              if (target === 'todo' && task.due_date) msg += ' (com prazo, ela fica na semana)';
            }
            action = { body: { list: target, order }, msg };
            zone.insertBefore(src, ph); // mostra o resultado na hora
          }
        }
      }
    }
    if (ph) ph.remove();
    if (drag.ghost) drag.ghost.remove();
    if (src) src.classList.remove('drag-source');
    if (zone) zone.classList.remove('drop-over');
    document.body.classList.remove('dragging');
    Object.assign(drag, { active: false, src: null, task: null, ghost: null, ph: null, zone: null, pid: null });
    if (wasActive) {
      drag.suppressClick = true; // o clique que vem logo depois de soltar não abre o editor
      setTimeout(() => { drag.suppressClick = false; }, 80);
    }
    if (action) {
      api('POST', `/api/tasks/${task.id}/move`, action.body)
        .then(() => { if (action.msg) toast(action.msg); })
        .catch((e) => toast(e.message, 4500))
        .finally(() => refresh());
    }
  }

  window.addEventListener('click', (e) => { if (drag.suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  document.addEventListener('touchmove', (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag.active) endDrag(false); });

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
          t = await api('POST', '/api/tasks', { text, ...(opts.status ? { status: opts.status } : {}) });
          const extra = t.due_date ? ` (prazo ${fmtDate(t.due_date)})` : t.recurrence_label ? ` (${t.recurrence_label.toLowerCase()})` : '';
          toast(`Anotado: ${t.title}${extra}`);
        }
        input.value = '';
        await refresh();
        $(opts.someday ? '#someday-body input' : opts.status ? `#${opts.status}-body input` : '#undated-body input')?.focus();
      } catch (err) {
        toast(err.message);
        input.disabled = false;
      }
    });
    li.append(tick, input);
    return li;
  }

  // Compromisso vindo do Google Agenda (só leitura)
  function renderEventItem(ev) {
    const li = document.createElement('div');
    li.className = 'paper-item event';
    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = ev.all_day ? 'dia' : ev.time;
    const main = document.createElement('div');
    main.className = 'paper-content';
    const title = document.createElement('span');
    title.className = 'paper-title';
    title.textContent = ev.title;
    main.appendChild(title);
    const meta = [];
    if (!ev.all_day && ev.end_time) meta.push(`até ${ev.end_time}`);
    if (ev.location) meta.push(ev.location);
    if (meta.length) {
      const m = document.createElement('span');
      m.className = 'paper-meta';
      m.textContent = meta.join(' · ');
      main.appendChild(m);
    }
    if (ev.link) main.addEventListener('click', () => window.open(ev.link, '_blank', 'noopener'));
    li.append(time, main);
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
    if (opts.showDate && t.due_date) meta.push((t.due_date < (state.today || todayYmd()) ? 'venceu ' : 'até ') + fmtDate(t.due_date));
    if (!opts.inSheet && t.status === 'doing') meta.push('em andamento');
    if (!opts.inSheet && t.status === 'leticia') meta.push((state.leticiaLabel || 'Ver com Letícia').toLowerCase());
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
    if (!t.virtual && !t.completed_at && t.id && !t.is_template) makeDraggable(li, t);
    return li;
  }

  $('#week-prev').addEventListener('click', () => { state.weekStart = addDays(state.weekStart || mondayOf(todayYmd()), -7); state.scrollToToday = true; refresh(); });
  $('#week-next').addEventListener('click', () => { state.weekStart = addDays(state.weekStart || mondayOf(todayYmd()), 7); state.scrollToToday = true; refresh(); });
  $('#week-today').addEventListener('click', () => { state.weekStart = mondayOf(todayYmd()); state.scrollToToday = true; refresh(); });

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

  // ---------- rótulo da lista "Ver com…" ----------
  function applyLabels(labels) {
    const l = (labels && labels.leticia) || 'Ver com Letícia';
    state.leticiaLabel = l;
    VIEW_TITLES.leticia = l;
    $('#row-leticia-label').textContent = l;
    $('#f-status-leticia').textContent = l;
    if (state.view === 'leticia') $('#page-title').textContent = l;
  }
  $('#s-leticia-label').addEventListener('change', async () => {
    const v = $('#s-leticia-label').value.trim() || 'Ver com Letícia';
    try { await api('PUT', '/api/settings', { leticia_label: v }); applyLabels({ leticia: v }); toast('Nome salvo'); }
    catch (e) { toast(e.message); }
  });

  // ---------- tema ----------
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { if (t === 'light' || t === 'dark') localStorage.setItem('organiza-theme', t); else localStorage.removeItem('organiza-theme'); } catch { /* ignore */ }
  }
  $('#s-theme').addEventListener('change', () => applyTheme($('#s-theme').value));

  // ---------- Google Agenda (API) ----------
  async function loadGcal() {
    try {
      const g = await api('GET', '/api/gcal/status');
      $('#gcal-dot').className = 'dot ' + (g.configured ? (g.lastError ? 'error' : 'connected') : 'disconnected');
      $('#gcal-status-text').textContent = !g.client_email ? 'Chave não configurada'
        : !g.calendar_id ? 'Chave salva; falta o ID da agenda'
          : g.lastError ? 'Com erro' : (g.push || g.pull ? 'Configurado' : 'Configurado (sincronização desligada)');
      const parts = [];
      if (g.client_email) parts.push(`Conta de serviço: ${g.client_email}`);
      if (g.lastSyncAt) parts.push(`Última sincronização: ${fmtDateTime(g.lastSyncAt)} (${g.lastSyncResult ? `${g.lastSyncResult.created} criados, ${g.lastSyncResult.updated} atualizados, ${g.lastSyncResult.deleted} removidos` : ''})`);
      if (g.mapped) parts.push(`${g.mapped} evento(s) mantidos na agenda`);
      if (g.lastError) parts.push(`Erro: ${g.lastError}`);
      $('#gcal-detail').textContent = parts.join(' · ');
      $('#gcal-calendar').value = state.settings?.gcal_calendar_id || '';
      $('#gcal-read').value = state.settings?.gcal_read_ids || '';
      $('#gcal-push').checked = state.settings?.gcal_push === '1';
      $('#gcal-pull').checked = state.settings?.gcal_pull === '1';
    } catch { /* ignore */ }
  }
  $('#gcal-save-json').addEventListener('click', async () => {
    const json = $('#gcal-json').value.trim();
    if (!json) { toast('Cole o conteúdo do arquivo JSON'); return; }
    try {
      const r = await api('POST', '/api/gcal/credentials', { json });
      $('#gcal-json').value = '';
      toast(`Chave salva: ${r.client_email}`, 5000);
      loadGcal();
    } catch (e) { toast(e.message, 6000); }
  });
  $('#gcal-remove-json').addEventListener('click', async () => {
    if (!confirm('Remover a chave da conta de serviço? A sincronização para.')) return;
    try { await api('DELETE', '/api/gcal/credentials'); toast('Chave removida'); loadGcal(); } catch (e) { toast(e.message); }
  });
  $('#gcal-save').addEventListener('click', async () => {
    try {
      const { settings } = await api('PUT', '/api/settings', {
        gcal_calendar_id: $('#gcal-calendar').value.trim(),
        gcal_read_ids: $('#gcal-read').value.trim(),
        gcal_push: $('#gcal-push').checked ? '1' : '0',
        gcal_pull: $('#gcal-pull').checked ? '1' : '0',
      });
      state.settings = settings;
      $('#gcal-saved').textContent = 'Salvo ✓';
      setTimeout(() => { $('#gcal-saved').textContent = ''; }, 2500);
      loadGcal();
    } catch (e) { toast(e.message); }
  });
  $('#gcal-test').addEventListener('click', async () => {
    $('#gcal-test').disabled = true;
    try { const r = await api('POST', '/api/gcal/test'); toast(`Conectado à agenda "${r.summary}" (${r.timeZone})`, 6000); }
    catch (e) { toast(e.message, 8000); }
    finally { $('#gcal-test').disabled = false; loadGcal(); }
  });
  $('#gcal-sync').addEventListener('click', async () => {
    $('#gcal-sync').disabled = true;
    try {
      const r = await api('POST', '/api/gcal/sync');
      toast(r.skipped ? 'Sincronização desligada ou sem chave' : `${r.created} criados, ${r.updated} atualizados, ${r.deleted} removidos${r.errors ? `, ${r.errors} erros` : ''}`, 6000);
    } catch (e) { toast(e.message, 8000); }
    finally { $('#gcal-sync').disabled = false; loadGcal(); }
  });

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
    loadGcal();
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
    $('#s-leticia-label').value = settings.leticia_label || '';
    $('#s-notify-wa').checked = settings.notify_whatsapp === '1';
    $('#s-notify-push').checked = settings.notify_push === '1';
    $('#s-digest-time').value = settings.digest_time || '';
    const days = (settings.digest_days || '').split(',');
    $$('#s-digest-days input').forEach((c) => { c.checked = days.includes(c.value); });
    refreshPushStatus();
    loadIcal();
    loadGcal();
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
