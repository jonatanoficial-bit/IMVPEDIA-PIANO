/* =========================================================
   IMVpedia Piano — app.js (SPA + Offline-first)
   Regras:
   - Hash routes
   - Fetch content.json
   - Fallbacks anti-quebra
   - Admin: create/export/import merge + validação
   - Progresso: XP, nível, lições, missões (localStorage)
========================================================= */

(() => {
  'use strict';

  /* =========================
     CONFIG
  ========================= */
  const APP = {
    name: 'IMVpedia Piano',
    subtitle: 'Piano Popular & Erudito',
    contentPath: './packs/base/imports/content.json',
    storageKey: 'imvpedia_piano_state_v1',
    adminDraftKey: 'imvpedia_piano_admin_buffer_v1',
    swUpdateToastKey: 'imvpedia_piano_sw_update_toast_v1',
    xp: {
      // thresholds inclusive
      levels: [
        { level: 1, min: 0, max: 199 },
        { level: 2, min: 200, max: 499 },
        { level: 3, min: 500, max: 999 },
        { level: 4, min: 1000, max: 1699 },
        { level: 5, min: 1700, max: 9999999 }
      ],
      defaultLessonXP: 20
    }
  };

  /* =========================
     DOM
  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const view = $('#view');
  const toastEl = $('#toast');
  const adminBtn = $('#adminBtn');

  /* =========================
     STATE
  ========================= */
  const state = {
    content: {
      loaded: false,
      items: [],
      byId: new Map(),
      tracks: [],
      lessons: [],
      missions: [],
      library: []
    },
    progress: {
      profileName: 'Aluno(a)',
      goal: 'Misto', // Popular | Erudito | Misto
      xp: 0,
      lessonDone: {}, // id -> true
      lessonChecklist: {}, // id -> { index: true }
      missionDoneByDay: {}, // yyyy-mm-dd -> { id: true }
      lastOpen: null
    },
    admin: {
      buffer: [] // created items (not yet merged)
    },
    ui: {
      swUpdateAvailable: false
    }
  };

  /* =========================
     UTILS
  ========================= */
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function nowISO() { return new Date().toISOString(); }

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${da}`;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // Very light markdown: headings, bold, lists, code inline, paragraphs
  function renderMarkdown(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');

    let html = '';
    let inList = false;

    const closeList = () => {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    };

    for (let raw of lines) {
      const line = raw.trimEnd();

      if (!line.trim()) {
        closeList();
        html += '<div class="spacer"></div>';
        continue;
      }

      // headings
      if (line.startsWith('### ')) { closeList(); html += `<h3>${inlineMd(line.slice(4))}</h3>`; continue; }
      if (line.startsWith('## '))  { closeList(); html += `<h2>${inlineMd(line.slice(3))}</h2>`; continue; }
      if (line.startsWith('# '))   { closeList(); html += `<h1>${inlineMd(line.slice(2))}</h1>`; continue; }

      // list
      if (/^[-*]\s+/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inlineMd(line.replace(/^[-*]\s+/, ''))}</li>`;
        continue;
      }

      closeList();
      html += `<p>${inlineMd(line)}</p>`;
    }

    closeList();
    return html;

    function inlineMd(s) {
      let t = escapeHtml(s);

      // inline code `x`
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');

      // bold **x**
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      // italics *x* (simple)
      t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');

      return t;
    }
  }

  function getLevelFromXP(xp) {
    const v = Number(xp) || 0;
    for (const r of APP.xp.levels) {
      if (v >= r.min && v <= r.max) return r;
    }
    return APP.xp.levels[0];
  }

  function getLevelProgress(xp) {
    const r = getLevelFromXP(xp);
    const span = Math.max(1, r.max - r.min + 1);
    const pct = ((xp - r.min) / span) * 100;
    return { ...r, pct: clamp(pct, 0, 100) };
  }

  function showToast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function safeJSONParse(text) {
    try { return { ok: true, value: JSON.parse(text) }; }
    catch (e) { return { ok: false, error: e?.message || 'JSON inválido' }; }
  }

  function getRoute() {
    const hash = location.hash || '#/home';
    const [path, qs] = hash.split('?');
    const params = new URLSearchParams(qs || '');
    return { path, params };
  }

  function navigate(to) {
    location.hash = to;
  }

  function setActiveTab(routePath) {
    $$('.tab-item').forEach(btn => {
      const r = btn.getAttribute('data-route');
      btn.classList.toggle('active', r === routePath);
    });
  }

  function loadStorage() {
    const raw = localStorage.getItem(APP.storageKey);
    if (!raw) return;
    const parsed = safeJSONParse(raw);
    if (!parsed.ok) return;
    const p = parsed.value;
    if (p && typeof p === 'object') {
      state.progress = {
        ...state.progress,
        ...p,
        lessonDone: p.lessonDone || {},
        lessonChecklist: p.lessonChecklist || {},
        missionDoneByDay: p.missionDoneByDay || {}
      };
    }
  }

  function saveStorage() {
    localStorage.setItem(APP.storageKey, JSON.stringify(state.progress));
  }

  function loadAdminBuffer() {
    const raw = localStorage.getItem(APP.adminDraftKey);
    if (!raw) return;
    const parsed = safeJSONParse(raw);
    if (!parsed.ok) return;
    if (Array.isArray(parsed.value)) state.admin.buffer = parsed.value;
  }

  function saveAdminBuffer() {
    localStorage.setItem(APP.adminDraftKey, JSON.stringify(state.admin.buffer));
  }

  function normalizeItem(item) {
    const base = {
      id: String(item.id || '').trim(),
      type: String(item.type || '').trim(),
      title: String(item.title || '').trim(),
      subtitle: item.subtitle ? String(item.subtitle) : '',
      cover: item.cover ? String(item.cover) : '',
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      level: item.level ? String(item.level) : '',
      category: item.category ? String(item.category) : '',
      body: item.body ? String(item.body) : '',
      version: typeof item.version === 'number' ? item.version : (item.version ? Number(item.version) : undefined),
      createdAt: item.createdAt ? String(item.createdAt) : undefined,
      updatedAt: item.updatedAt ? String(item.updatedAt) : undefined
    };

    if (base.type === 'track') {
      return {
        ...base,
        lessonIds: Array.isArray(item.lessonIds) ? item.lessonIds.map(String) : [],
        order: typeof item.order === 'number' ? item.order : (item.order ? Number(item.order) : undefined)
      };
    }

    if (base.type === 'lesson') {
      return {
        ...base,
        sections: Array.isArray(item.sections) ? item.sections : undefined,
        checklist: Array.isArray(item.checklist) ? item.checklist.map(String) : [],
        estimatedMinutes: item.estimatedMinutes ? Number(item.estimatedMinutes) : undefined,
        xp: item.xp ? Number(item.xp) : undefined
      };
    }

    if (base.type === 'library') {
      return {
        ...base,
        readingMinutes: item.readingMinutes ? Number(item.readingMinutes) : undefined
      };
    }

    if (base.type === 'mission') {
      return {
        ...base,
        xp: item.xp ? Number(item.xp) : 0,
        repeat: item.repeat ? String(item.repeat) : 'daily',
        missionKind: item.missionKind ? String(item.missionKind) : '',
        steps: Array.isArray(item.steps) ? item.steps.map(String) : []
      };
    }

    return base;
  }

  function validateItems(items) {
    const errors = [];
    const warnings = [];
    const allowed = new Set(['track', 'lesson', 'library', 'mission']);
    const seen = new Set();

    if (!Array.isArray(items)) {
      errors.push('O JSON precisa ser um array de itens.');
      return { ok: false, errors, warnings };
    }

    items.forEach((it, idx) => {
      const i = normalizeItem(it);

      if (!i.id) errors.push(`Item #${idx + 1}: "id" ausente.`);
      if (!i.type) errors.push(`Item #${idx + 1}: "type" ausente.`);
      if (i.type && !allowed.has(i.type)) errors.push(`Item #${idx + 1}: "type" inválido (${i.type}).`);
      if (!i.title) errors.push(`Item #${idx + 1}: "title" ausente.`);

      if (i.id) {
        if (seen.has(i.id)) errors.push(`Item #${idx + 1}: id duplicado no import (${i.id}).`);
        seen.add(i.id);
      }

      if (i.type === 'track') {
        if (!Array.isArray(i.lessonIds)) errors.push(`Track ${i.id}: "lessonIds" precisa ser array.`);
      }

      if (i.type === 'mission') {
        if (!Number.isFinite(i.xp) || i.xp <= 0) warnings.push(`Mission ${i.id}: xp ausente/zero. (Recomendado > 0)`);
      }
    });

    return { ok: errors.length === 0, errors, warnings };
  }

  function rebuildIndex() {
    state.content.byId = new Map();
    state.content.tracks = [];
    state.content.lessons = [];
    state.content.missions = [];
    state.content.library = [];

    for (const item of state.content.items) {
      state.content.byId.set(item.id, item);
      if (item.type === 'track') state.content.tracks.push(item);
      if (item.type === 'lesson') state.content.lessons.push(item);
      if (item.type === 'mission') state.content.missions.push(item);
      if (item.type === 'library') state.content.library.push(item);
    }

    // Sort tracks by order then title
    state.content.tracks.sort((a, b) => {
      const ao = Number.isFinite(a.order) ? a.order : 999999;
      const bo = Number.isFinite(b.order) ? b.order : 999999;
      if (ao !== bo) return ao - bo;
      return String(a.title).localeCompare(String(b.title));
    });
  }

  async function loadContent() {
    // Try fetch content.json with cache hints
    try {
      const res = await fetch(APP.contentPath, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const v = validateItems(data);
      if (!v.ok) throw new Error(v.errors.join('\n'));
      state.content.items = data.map(normalizeItem);
      rebuildIndex();
      state.content.loaded = true;
      return true;
    } catch (e) {
      console.error('loadContent failed', e);
      state.content.loaded = false;
      return false;
    }
  }

  /* =========================
     PROGRESS HELPERS
  ========================= */
  function lessonIsDone(id) {
    return !!state.progress.lessonDone[id];
  }

  function setLessonDone(id, done) {
    state.progress.lessonDone[id] = !!done;
    saveStorage();
  }

  function getLessonChecklist(id) {
    return state.progress.lessonChecklist[id] || {};
  }

  function setLessonChecklist(id, idx, val) {
    const map = state.progress.lessonChecklist[id] || {};
    map[idx] = !!val;
    state.progress.lessonChecklist[id] = map;
    saveStorage();
  }

  function grantXP(amount) {
    const a = Math.max(0, Number(amount) || 0);
    if (!a) return;
    state.progress.xp = (Number(state.progress.xp) || 0) + a;
    saveStorage();
  }

  function missionDoneToday(id) {
    const k = todayKey();
    const bucket = state.progress.missionDoneByDay[k] || {};
    return !!bucket[id];
  }

  function setMissionDoneToday(id) {
    const k = todayKey();
    const bucket = state.progress.missionDoneByDay[k] || {};
    bucket[id] = true;
    state.progress.missionDoneByDay[k] = bucket;
    saveStorage();
  }

  function computeOverallProgress() {
    const totalLessons = state.content.lessons.length || 0;
    if (!totalLessons) return { pct: 0, done: 0, total: 0 };
    let done = 0;
    for (const l of state.content.lessons) if (lessonIsDone(l.id)) done++;
    const pct = (done / totalLessons) * 100;
    return { pct: clamp(pct, 0, 100), done, total: totalLessons };
  }

  function findNextLessonRecommendation() {
    // First track with pending lesson, return first pending lesson
    for (const trk of state.content.tracks) {
      const ids = Array.isArray(trk.lessonIds) ? trk.lessonIds : [];
      for (const id of ids) {
        const l = state.content.byId.get(id);
        if (l && l.type === 'lesson' && !lessonIsDone(l.id)) return l;
      }
    }
    // fallback: first not done lesson
    for (const l of state.content.lessons) {
      if (!lessonIsDone(l.id)) return l;
    }
    return null;
  }

  /* =========================
     UI BUILDERS
  ========================= */
  function cardGlass(innerHtml) {
    return `<section class="card glass">${innerHtml}</section>`;
  }

  function chip(text) {
    if (!text) return '';
    return `<span class="chip">${escapeHtml(text)}</span>`;
  }

  function renderProgressBar(pct) {
    const w = clamp(pct, 0, 100).toFixed(0);
    return `
      <div class="progress">
        <div class="progress-fill" style="width:${w}%"></div>
      </div>
    `;
  }

  function renderCover(cover) {
    if (!cover) return '';
    const safe = escapeHtml(cover);
    return `<div class="cover" style="background-image:url('${safe}')"></div>`;
  }

  function renderTagRow(item) {
    const parts = [];
    if (item.category) parts.push(chip(item.category));
    if (item.level) parts.push(chip(item.level));
    if (Array.isArray(item.tags)) {
      for (const t of item.tags.slice(0, 3)) parts.push(chip(t));
    }
    return parts.length ? `<div class="chiprow">${parts.join('')}</div>` : '';
  }

  function renderFallback(title, msg, extraHtml = '') {
    return `
      ${cardGlass(`
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(msg)}</p>
        <div class="actions-row">
          <button class="btn primary" data-action="retryContent">Tentar novamente</button>
          <button class="btn ghost" data-action="goHome">Ir para Início</button>
        </div>
        ${extraHtml}
      `)}
    `;
  }

  /* =========================
     ROUTE RENDERERS
  ========================= */
  function renderHome() {
    const prog = computeOverallProgress();
    const lvl = getLevelProgress(state.progress.xp);
    const next = findNextLessonRecommendation();

    const missionOfDay = pickMissionOfDay();

    const hero = cardGlass(`
      <div class="hero">
        <div class="hero-left">
          <div class="hero-kicker">Seu progresso</div>
          <h2>Continue evoluindo no piano</h2>
          <p>Base + Popular + Erudito em uma rotina clara e consistente.</p>

          <div class="metrics">
            <div class="metric">
              <div class="metric-label">Nível</div>
              <div class="metric-value">Lv ${lvl.level}</div>
            </div>
            <div class="metric">
              <div class="metric-label">XP</div>
              <div class="metric-value">${state.progress.xp}</div>
            </div>
            <div class="metric">
              <div class="metric-label">Lições</div>
              <div class="metric-value">${prog.done}/${prog.total}</div>
            </div>
          </div>

          ${renderProgressBar(prog.pct)}
        </div>

        <div class="hero-right">
          <div class="hero-badge">Accent</div>
        </div>
      </div>
    `);

    const quick = cardGlass(`
      <h2>Acesso rápido</h2>
      <p>Retome exatamente onde faz mais diferença.</p>

      <div class="grid">
        <button class="tile glass" data-action="goPath">
          <div class="tile-title">Trilhas</div>
          <div class="tile-sub">Módulos guiados</div>
        </button>

        <button class="tile glass" data-action="goMissions">
          <div class="tile-title">Missões</div>
          <div class="tile-sub">XP diário</div>
        </button>

        <button class="tile glass" data-action="goLibrary">
          <div class="tile-title">Biblioteca</div>
          <div class="tile-sub">Artigos essenciais</div>
        </button>

        <button class="tile glass" data-action="goProfile">
          <div class="tile-title">Perfil</div>
          <div class="tile-sub">Meta e nível</div>
        </button>
      </div>
    `);

    const nextCard = next ? cardGlass(`
      <h2>Próxima lição recomendada</h2>
      <p>${escapeHtml(next.title)}</p>
      ${renderTagRow(next)}
      <div class="actions-row">
        <button class="btn primary" data-action="openLesson" data-id="${escapeHtml(next.id)}">Abrir lição</button>
        <button class="btn ghost" data-action="goPath">Ver trilhas</button>
      </div>
    `) : cardGlass(`
      <h2>Você concluiu tudo 🎉</h2>
      <p>Importe novos conteúdos no Admin para continuar evoluindo.</p>
      <div class="actions-row">
        <button class="btn primary" data-action="goAdmin">Abrir Admin</button>
      </div>
    `);

    const missionCard = missionOfDay ? cardGlass(`
      <h2>Missão do dia</h2>
      <p><strong>${escapeHtml(missionOfDay.title)}</strong></p>
      <p>${escapeHtml(missionOfDay.subtitle || '')}</p>
      ${renderTagRow(missionOfDay)}
      <div class="actions-row">
        <button class="btn primary" data-action="completeMission" data-id="${escapeHtml(missionOfDay.id)}" ${missionDoneToday(missionOfDay.id) ? 'disabled' : ''}>
          ${missionDoneToday(missionOfDay.id) ? 'Concluída ✅' : `Concluir (+${missionOfDay.xp} XP)`}
        </button>
        <button class="btn ghost" data-action="goMissions">Ver todas</button>
      </div>
    `) : '';

    return hero + quick + nextCard + missionCard;
  }

  function renderPath() {
    const tracks = state.content.tracks;

    if (!tracks.length) {
      return cardGlass(`
        <h2>Sem trilhas</h2>
        <p>Nenhuma trilha encontrada no conteúdo atual.</p>
        <div class="actions-row">
          <button class="btn primary" data-action="goAdmin">Adicionar pelo Admin</button>
        </div>
      `);
    }

    const list = tracks.map(trk => {
      const ids = Array.isArray(trk.lessonIds) ? trk.lessonIds : [];
      const total = ids.length || 0;
      let done = 0;
      ids.forEach(id => { if (lessonIsDone(id)) done++; });
      const pct = total ? (done / total) * 100 : 0;

      return `
        <button class="track-card glass" data-action="openTrack" data-id="${escapeHtml(trk.id)}">
          ${renderCover(trk.cover)}
          <div class="track-body">
            <div class="track-title">${escapeHtml(trk.title)}</div>
            <div class="track-sub">${escapeHtml(trk.subtitle || '')}</div>
            ${renderTagRow(trk)}
            <div class="track-meta">
              <span>${done}/${total} lições</span>
              <span>${pct.toFixed(0)}%</span>
            </div>
            ${renderProgressBar(pct)}
          </div>
        </button>
      `;
    }).join('');

    return `
      ${cardGlass(`
        <h2>Trilhas</h2>
        <p>Escolha um módulo e siga lição por lição.</p>
      `)}
      <div class="stack">${list}</div>
    `;
  }

  function renderTrack(id) {
    const trk = state.content.byId.get(id);
    if (!trk || trk.type !== 'track') {
      return renderFallback('Trilha não encontrada', 'Esse módulo não existe ou foi removido.');
    }

    const ids = Array.isArray(trk.lessonIds) ? trk.lessonIds : [];
    const lessons = ids.map(x => state.content.byId.get(x)).filter(Boolean).filter(x => x.type === 'lesson');

    const header = cardGlass(`
      <h2>${escapeHtml(trk.title)}</h2>
      <p>${escapeHtml(trk.subtitle || '')}</p>
      ${renderTagRow(trk)}
      <div class="actions-row">
        <button class="btn ghost" data-action="goPath">Voltar</button>
      </div>
    `);

    if (!ids.length) {
      return header + cardGlass(`
        <h2>Sem lições</h2>
        <p>Essa trilha ainda não possui lições. Use o Admin para adicionar.</p>
        <div class="actions-row">
          <button class="btn primary" data-action="goAdmin">Abrir Admin</button>
        </div>
      `);
    }

    if (!lessons.length) {
      return header + cardGlass(`
        <h2>Lições não encontradas</h2>
        <p>Essa trilha aponta para lições inexistentes no conteúdo atual.</p>
        <div class="actions-row">
          <button class="btn primary" data-action="goAdmin">Resolver no Admin</button>
        </div>
      `);
    }

    const list = lessons.map(ls => {
      const done = lessonIsDone(ls.id);
      return `
        <button class="lesson-row glass" data-action="openLesson" data-id="${escapeHtml(ls.id)}">
          <div class="lesson-left">
            <div class="lesson-title">${escapeHtml(ls.title)}</div>
            <div class="lesson-sub">${escapeHtml(ls.subtitle || '')}</div>
            ${renderTagRow(ls)}
          </div>
          <div class="lesson-right">
            <div class="pill ${done ? 'pill-done' : 'pill-pending'}">
              ${done ? 'Concluída' : 'Pendente'}
            </div>
          </div>
        </button>
      `;
    }).join('');

    return header + `<div class="stack">${list}</div>`;
  }

  function renderLesson(id) {
    const ls = state.content.byId.get(id);
    if (!ls || ls.type !== 'lesson') {
      return renderFallback('Lição não encontrada', 'Essa lição não existe ou foi removida.');
    }

    const done = lessonIsDone(ls.id);
    const xp = Number.isFinite(ls.xp) ? ls.xp : APP.xp.defaultLessonXP;
    const checklist = Array.isArray(ls.checklist) ? ls.checklist : [];
    const map = getLessonChecklist(ls.id);

    const checklistHtml = checklist.length ? `
      <div class="checklist">
        <div class="checklist-title">Checklist</div>
        ${checklist.map((t, idx) => {
          const checked = !!map[idx];
          return `
            <label class="checkline glass">
              <input type="checkbox" data-action="toggleChecklist" data-id="${escapeHtml(ls.id)}" data-idx="${idx}" ${checked ? 'checked' : ''} />
              <span>${escapeHtml(t)}</span>
            </label>
          `;
        }).join('')}
      </div>
    ` : '';

    return `
      ${cardGlass(`
        <h2>${escapeHtml(ls.title)}</h2>
        <p>${escapeHtml(ls.subtitle || '')}</p>
        ${renderTagRow(ls)}
        <div class="actions-row">
          <button class="btn ghost" data-action="goBack">Voltar</button>
          <button class="btn primary" data-action="completeLesson" data-id="${escapeHtml(ls.id)}" ${done ? 'disabled' : ''}>
            ${done ? 'Concluída ✅' : `Concluir lição (+${xp} XP)`}
          </button>
        </div>
      `)}

      ${cardGlass(`
        <div class="md">${renderMarkdown(ls.body || '')}</div>
      `)}

      ${checklistHtml}
    `;
  }

  function renderMissions() {
    const missions = state.content.missions;
    if (!missions.length) {
      return cardGlass(`
        <h2>Sem missões</h2>
        <p>Nenhuma missão encontrada no conteúdo atual.</p>
        <div class="actions-row">
          <button class="btn primary" data-action="goAdmin">Adicionar pelo Admin</button>
        </div>
      `);
    }

    const list = missions.map(m => {
      const done = missionDoneToday(m.id) && (m.repeat !== 'once');
      const disabled = missionDoneToday(m.id) && (m.repeat === 'daily' || m.repeat === 'weekly');
      const isOnceDone = (m.repeat === 'once') && missionDoneToday(m.id);
      const canComplete = !(disabled || isOnceDone);

      return `
        <div class="mission-card card glass">
          <div class="mission-head">
            <div>
              <div class="mission-title">${escapeHtml(m.title)}</div>
              <div class="mission-sub">${escapeHtml(m.subtitle || '')}</div>
              ${renderTagRow(m)}
            </div>
            <div class="mission-xp">+${escapeHtml(m.xp)}</div>
          </div>

          ${Array.isArray(m.steps) && m.steps.length ? `
            <div class="mini-steps">
              ${m.steps.slice(0, 4).map(s => `<div class="mini-step">• ${escapeHtml(s)}</div>`).join('')}
            </div>
          ` : ''}

          <div class="actions-row">
            <button class="btn primary" data-action="completeMission" data-id="${escapeHtml(m.id)}" ${canComplete ? '' : 'disabled'}>
              ${canComplete ? 'Concluir (+XP)' : 'Concluída ✅'}
            </button>
          </div>
        </div>
      `;
    }).join('');

    return `
      ${cardGlass(`
        <h2>Missões</h2>
        <p>Complete pequenas ações diárias para ganhar XP.</p>
      `)}
      <div class="stack">${list}</div>
    `;
  }

  function renderLibrary() {
    const libs = state.content.library;
    if (!libs.length) {
      return cardGlass(`
        <h2>Sem artigos</h2>
        <p>Nenhum item de biblioteca encontrado no conteúdo atual.</p>
        <div class="actions-row">
          <button class="btn primary" data-action="goAdmin">Adicionar pelo Admin</button>
        </div>
      `);
    }

    const list = libs.map(a => `
      <button class="article-row glass" data-action="openArticle" data-id="${escapeHtml(a.id)}">
        <div class="article-title">${escapeHtml(a.title)}</div>
        <div class="article-sub">${escapeHtml(a.subtitle || '')}</div>
        ${renderTagRow(a)}
      </button>
    `).join('');

    return `
      ${cardGlass(`
        <h2>Biblioteca</h2>
        <p>Textos essenciais para estudar com clareza e consistência.</p>
      `)}
      <div class="stack">${list}</div>
    `;
  }

  function renderArticle(id) {
    const a = state.content.byId.get(id);
    if (!a || a.type !== 'library') {
      return renderFallback('Artigo não encontrado', 'Esse artigo não existe ou foi removido.');
    }

    return `
      ${cardGlass(`
        <h2>${escapeHtml(a.title)}</h2>
        <p>${escapeHtml(a.subtitle || '')}</p>
        ${renderTagRow(a)}
        <div class="actions-row">
          <button class="btn ghost" data-action="goBack">Voltar</button>
        </div>
      `)}
      ${cardGlass(`<div class="md">${renderMarkdown(a.body || '')}</div>`)}
    `;
  }

  function renderProfile() {
    const prog = computeOverallProgress();
    const lvl = getLevelProgress(state.progress.xp);

    return `
      ${cardGlass(`
        <h2>Perfil</h2>
        <p>Defina seu objetivo e acompanhe seu nível.</p>

        <div class="profile-grid">
          <div class="field">
            <div class="field-label">Nome</div>
            <input id="profileName" class="input glass" value="${escapeHtml(state.progress.profileName)}" />
          </div>

          <div class="field">
            <div class="field-label">Objetivo</div>
            <div class="segmented glass">
              ${['Popular', 'Erudito', 'Misto'].map(g => `
                <button class="seg-btn ${state.progress.goal === g ? 'active' : ''}" data-action="setGoal" data-goal="${g}">
                  ${g}
                </button>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="metrics metrics-profile">
          <div class="metric">
            <div class="metric-label">Nível</div>
            <div class="metric-value">Lv ${lvl.level}</div>
          </div>
          <div class="metric">
            <div class="metric-label">XP</div>
            <div class="metric-value">${state.progress.xp}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Progresso</div>
            <div class="metric-value">${prog.done}/${prog.total}</div>
          </div>
        </div>

        ${renderProgressBar(lvl.pct)}

        <div class="actions-row">
          <button class="btn ghost" data-action="resetProgress">Resetar progresso</button>
        </div>
      `)}
    `;
  }

  function renderAdmin() {
    // Lists for track creation
    const lessonOptions = state.content.lessons
      .map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.title)} (${escapeHtml(l.id)})</option>`)
      .join('');

    const bufferCount = state.admin.buffer.length;

    return `
      ${cardGlass(`
        <h2>Admin Hub</h2>
        <p>Crie conteúdos sem programar e exporte/importa JSON com segurança.</p>
        <div class="actions-row">
          <button class="btn ghost" data-action="goHome">Voltar</button>
          <button class="btn primary" data-action="exportBuffer">Exportar (${bufferCount})</button>
        </div>
      `)}

      ${cardGlass(`
        <h2>1) Gerador</h2>
        <p>Crie um item: lesson / library / mission / track.</p>

        <div class="admin-form">
          <div class="field">
            <div class="field-label">Tipo</div>
            <select id="admType" class="input glass">
              <option value="lesson">lesson</option>
              <option value="library">library</option>
              <option value="mission">mission</option>
              <option value="track">track</option>
            </select>
          </div>

          <div class="field">
            <div class="field-label">ID (único)</div>
            <div class="row">
              <input id="admId" class="input glass" placeholder="ex: les_base_001" />
              <button class="btn ghost" data-action="genId">Gerar</button>
            </div>
          </div>

          <div class="field">
            <div class="field-label">Título</div>
            <input id="admTitle" class="input glass" placeholder="Título do item" />
          </div>

          <div class="field">
            <div class="field-label">Subtítulo</div>
            <input id="admSubtitle" class="input glass" placeholder="Descrição curta" />
          </div>

          <div class="field">
            <div class="field-label">Capa (URL opcional)</div>
            <input id="admCover" class="input glass" placeholder="https://..." />
          </div>

          <div class="field">
            <div class="field-label">Categoria</div>
            <select id="admCategory" class="input glass">
              <option value="">(vazio)</option>
              <option value="Base comum">Base comum</option>
              <option value="Piano Popular">Piano Popular</option>
              <option value="Piano Erudito">Piano Erudito</option>
            </select>
          </div>

          <div class="field">
            <div class="field-label">Nível</div>
            <select id="admLevel" class="input glass">
              <option value="">(vazio)</option>
              <option value="Iniciante absoluto">Iniciante absoluto</option>
              <option value="Iniciante">Iniciante</option>
              <option value="Intermediário">Intermediário</option>
              <option value="Avançado">Avançado</option>
            </select>
          </div>

          <div class="field">
            <div class="field-label">Tags (separe por vírgula)</div>
            <input id="admTags" class="input glass" placeholder="técnica, leitura, acordes..." />
          </div>

          <div class="field" id="admBodyWrap">
            <div class="field-label">Texto (markdown leve)</div>
            <textarea id="admBody" class="textarea glass" rows="8" placeholder="# Título&#10;Texto..."></textarea>
          </div>

          <div class="field" id="admChecklistWrap">
            <div class="field-label">Checklist / Steps (1 por linha)</div>
            <textarea id="admChecklist" class="textarea glass" rows="5" placeholder="1) ...&#10;2) ..."></textarea>
          </div>

          <div class="field" id="admXpWrap">
            <div class="field-label">XP (mission/lesson)</div>
            <input id="admXp" class="input glass" type="number" placeholder="ex: 20" />
          </div>

          <div class="field" id="admLessonIdsWrap" style="display:none">
            <div class="field-label">lessonIds (para track)</div>
            <select id="admLessonIds" class="input glass" multiple size="6">
              ${lessonOptions}
            </select>
            <div class="hint">Dica: segure Ctrl/Cmd para selecionar várias.</div>
          </div>

          <div class="actions-row">
            <button class="btn primary" data-action="addToBuffer">Adicionar ao buffer</button>
            <button class="btn ghost" data-action="clearAdminForm">Limpar</button>
          </div>
        </div>

        <div class="admin-preview">
          <div class="field-label">Preview</div>
          <div id="admPreview" class="card glass">
            <p class="muted">Preencha o formulário para ver o preview.</p>
          </div>
        </div>
      `)}

      ${cardGlass(`
        <h2>2) Exportador</h2>
        <p>O buffer atual tem <strong>${bufferCount}</strong> item(ns). Exporte para copiar o JSON.</p>
        <div class="actions-row">
          <button class="btn primary" data-action="exportBuffer">Gerar JSON</button>
          <button class="btn ghost" data-action="clearBuffer">Limpar buffer</button>
        </div>
        <textarea id="admExport" class="textarea glass" rows="10" placeholder="O JSON aparecerá aqui..." readonly></textarea>
      `)}

      ${cardGlass(`
        <h2>3) Importador seguro (mesclar)</h2>
        <p>Cole um array JSON. Ele valida, evita duplicidade de id e mostra relatório.</p>

        <textarea id="admImport" class="textarea glass" rows="10" placeholder='[{"id":"...","type":"lesson","title":"..."}]'></textarea>

        <div class="actions-row">
          <button class="btn primary" data-action="importMerge">Importar e mesclar</button>
          <button class="btn ghost" data-action="importValidate">Validar apenas</button>
        </div>

        <div id="admReport" class="report"></div>
      `)}
    `;
  }

  /* =========================
     MISSION OF DAY
  ========================= */
  function pickMissionOfDay() {
    const missions = state.content.missions.filter(m => m.repeat === 'daily' || !m.repeat);
    if (!missions.length) return null;

    // deterministic pick by day
    const k = todayKey();
    let hash = 0;
    for (let i = 0; i < k.length; i++) hash = (hash * 31 + k.charCodeAt(i)) >>> 0;
    const idx = hash % missions.length;
    return missions[idx];
  }

  /* =========================
     RENDER ROUTER
  ========================= */
  function render() {
    const { path, params } = getRoute();

    // Active tab only for main tabs
    const tabRoutes = new Set(['#/home', '#/path', '#/missions', '#/library', '#/profile']);
    setActiveTab(tabRoutes.has(path) ? path : '');

    if (!state.content.loaded) {
      view.innerHTML = renderFallback(
        'Conteúdo não carregou',
        'Não foi possível carregar packs/base/imports/content.json. Verifique se o arquivo existe e se está sendo servido corretamente (GitHub Pages).'
      );
      return;
    }

    // Route dispatch
    if (path === '#/home') return (view.innerHTML = renderHome());
    if (path === '#/path') return (view.innerHTML = renderPath());
    if (path === '#/missions') return (view.innerHTML = renderMissions());
    if (path === '#/library') return (view.innerHTML = renderLibrary());
    if (path === '#/profile') return (view.innerHTML = renderProfile());
    if (path === '#/admin') return (view.innerHTML = renderAdmin());

    if (path === '#/track') {
      const id = params.get('id') || '';
      return (view.innerHTML = renderTrack(id));
    }

    if (path === '#/lesson') {
      const id = params.get('id') || '';
      return (view.innerHTML = renderLesson(id));
    }

    if (path === '#/article') {
      const id = params.get('id') || '';
      return (view.innerHTML = renderArticle(id));
    }

    // Unknown route -> home
    navigate('#/home');
  }

  /* =========================
     EVENTS
  ========================= */
  function onClick(e) {
    const t = e.target;

    // Tabbar navigation
    const tabBtn = t.closest('.tab-item');
    if (tabBtn) {
      const r = tabBtn.getAttribute('data-route');
      if (r) navigate(r);
      return;
    }

    // Actions
    const actEl = t.closest('[data-action]');
    if (!actEl) return;
    const action = actEl.getAttribute('data-action');

    if (action === 'goHome') return navigate('#/home');
    if (action === 'goPath') return navigate('#/path');
    if (action === 'goMissions') return navigate('#/missions');
    if (action === 'goLibrary') return navigate('#/library');
    if (action === 'goProfile') return navigate('#/profile');
    if (action === 'goAdmin') return navigate('#/admin');
    if (action === 'goBack') return history.back();
    if (action === 'retryContent') return init(true);

    if (action === 'openTrack') {
      const id = actEl.getAttribute('data-id');
      return navigate(`#/track?id=${encodeURIComponent(id)}`);
    }

    if (action === 'openLesson') {
      const id = actEl.getAttribute('data-id');
      return navigate(`#/lesson?id=${encodeURIComponent(id)}`);
    }

    if (action === 'openArticle') {
      const id = actEl.getAttribute('data-id');
      return navigate(`#/article?id=${encodeURIComponent(id)}`);
    }

    if (action === 'completeLesson') {
      const id = actEl.getAttribute('data-id');
      const ls = state.content.byId.get(id);
      if (!ls) return showToast('Lição não encontrada.');
      if (lessonIsDone(id)) return showToast('Lição já concluída.');
      const xp = Number.isFinite(ls.xp) ? ls.xp : APP.xp.defaultLessonXP;
      setLessonDone(id, true);
      grantXP(xp);
      showToast(`Lição concluída! +${xp} XP`);
      render();
      return;
    }

    if (action === 'completeMission') {
      const id = actEl.getAttribute('data-id');
      const m = state.content.byId.get(id);
      if (!m) return showToast('Missão não encontrada.');
      if (missionDoneToday(id)) return showToast('Missão já concluída hoje.');
      setMissionDoneToday(id);
      grantXP(m.xp || 0);
      showToast(`Missão concluída! +${m.xp || 0} XP`);
      render();
      return;
    }

    // Admin actions
    if (action === 'genId') {
      const type = ($('#admType')?.value || 'lesson').trim();
      const base = type === 'track' ? 'trk' : type === 'lesson' ? 'les' : type === 'library' ? 'lib' : 'mis';
      const rand = Math.random().toString(16).slice(2, 6);
      const cat = ($('#admCategory')?.value || '').toLowerCase().includes('popular') ? 'pop'
        : ($('#admCategory')?.value || '').toLowerCase().includes('erudito') ? 'eru'
        : 'base';
      const id = `${base}_${cat}_${rand}`;
      const input = $('#admId');
      if (input) input.value = id;
      updateAdminPreview();
      return;
    }

    if (action === 'clearAdminForm') {
      clearAdminForm();
      updateAdminPreview();
      return;
    }

    if (action === 'addToBuffer') {
      const item = buildAdminItemFromForm();
      if (!item) return;

      // Validate id uniqueness vs existing content and buffer
      const id = item.id;
      if (state.content.byId.has(id)) {
        showToast(`ID já existe no conteúdo: ${id}`);
        return;
      }
      if (state.admin.buffer.some(x => x.id === id)) {
        showToast(`ID já existe no buffer: ${id}`);
        return;
      }

      // Minimal validate
      const v = validateItems([item]);
      if (!v.ok) {
        showToast(v.errors[0] || 'Item inválido.');
        return;
      }

      state.admin.buffer.push(item);
      saveAdminBuffer();
      showToast('Item adicionado ao buffer.');
      updateAdminPreview();
      render(); // refresh counts
      return;
    }

    if (action === 'exportBuffer') {
      const ta = $('#admExport');
      if (!ta) return;
      const json = JSON.stringify(state.admin.buffer, null, 2);
      ta.value = json;
      ta.scrollTop = 0;
      showToast('JSON gerado no exportador.');
      return;
    }

    if (action === 'clearBuffer') {
      state.admin.buffer = [];
      saveAdminBuffer();
      const ta = $('#admExport'); if (ta) ta.value = '';
      showToast('Buffer limpo.');
      render();
      return;
    }

    if (action === 'importValidate') {
      const input = $('#admImport');
      const report = $('#admReport');
      if (!input || !report) return;

      const parsed = safeJSONParse(input.value);
      if (!parsed.ok) {
        report.innerHTML = `<div class="bad">JSON inválido: ${escapeHtml(parsed.error)}</div>`;
        return;
      }

      const v = validateItems(parsed.value);
      report.innerHTML = renderValidationReport(v, parsed.value);
      return;
    }

    if (action === 'importMerge') {
      const input = $('#admImport');
      const report = $('#admReport');
      if (!input || !report) return;

      const parsed = safeJSONParse(input.value);
      if (!parsed.ok) {
        report.innerHTML = `<div class="bad">JSON inválido: ${escapeHtml(parsed.error)}</div>`;
        return;
      }

      const items = parsed.value;
      const v = validateItems(items);
      if (!v.ok) {
        report.innerHTML = renderValidationReport(v, items);
        return;
      }

      // Merge: do not overwrite existing ids
      let inserted = 0;
      let ignored = 0;
      const missingRefs = [];

      const normalized = items.map(normalizeItem);

      for (const it of normalized) {
        if (state.content.byId.has(it.id)) { ignored++; continue; }
        state.content.items.push(it);
        inserted++;
      }

      rebuildIndex();

      // Check track lesson refs
      for (const trk of state.content.tracks) {
        const ids = Array.isArray(trk.lessonIds) ? trk.lessonIds : [];
        for (const id of ids) {
          const ref = state.content.byId.get(id);
          if (!ref || ref.type !== 'lesson') missingRefs.push({ track: trk.id, lessonId: id });
        }
      }

      report.innerHTML = `
        <div class="ok">Import finalizado.</div>
        <div>Inseridos: <strong>${inserted}</strong></div>
        <div>Ignorados (id duplicado): <strong>${ignored}</strong></div>
        ${v.warnings.length ? `<div class="warn"><strong>Avisos:</strong><br>${v.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
        ${missingRefs.length ? `<div class="warn"><strong>Referências faltantes (tracks → lessons):</strong><br>${missingRefs.slice(0, 20).map(x => `Track ${escapeHtml(x.track)} → ${escapeHtml(x.lessonId)}`).join('<br>')}${missingRefs.length > 20 ? '<br>...' : ''}</div>` : ''}
      `;

      showToast(`Importado: ${inserted} inseridos, ${ignored} ignorados.`);
      render();
      return;
    }

    if (action === 'setGoal') {
      const g = actEl.getAttribute('data-goal');
      if (!g) return;
      state.progress.goal = g;
      saveStorage();
      showToast(`Objetivo: ${g}`);
      render();
      return;
    }

    if (action === 'resetProgress') {
      if (!confirm('Resetar XP, lições e missões?')) return;
      state.progress.xp = 0;
      state.progress.lessonDone = {};
      state.progress.lessonChecklist = {};
      state.progress.missionDoneByDay = {};
      saveStorage();
      showToast('Progresso resetado.');
      render();
      return;
    }
  }

  function onChange(e) {
    const t = e.target;

    if (t && t.id === 'profileName') {
      state.progress.profileName = t.value.slice(0, 40) || 'Aluno(a)';
      saveStorage();
      return;
    }

    // checklist checkbox
    if (t && t.matches('input[type="checkbox"][data-action="toggleChecklist"]')) {
      const id = t.getAttribute('data-id');
      const idx = Number(t.getAttribute('data-idx'));
      setLessonChecklist(id, idx, t.checked);
      return;
    }

    // admin type change toggles
    if (t && t.id === 'admType') {
      toggleAdminFields();
      updateAdminPreview();
      return;
    }

    // any admin field updates preview
    if (t && ['admId','admTitle','admSubtitle','admCover','admCategory','admLevel','admTags','admBody','admChecklist','admXp','admLessonIds'].includes(t.id)) {
      updateAdminPreview();
      return;
    }
  }

  function renderValidationReport(v, items) {
    const count = Array.isArray(items) ? items.length : 0;
    return `
      <div class="${v.ok ? 'ok' : 'bad'}">
        ${v.ok ? 'Validação OK' : 'Validação com erros'}
      </div>
      <div>Itens no import: <strong>${count}</strong></div>
      ${v.errors.length ? `<div class="bad"><strong>Erros:</strong><br>${v.errors.map(escapeHtml).join('<br>')}</div>` : ''}
      ${v.warnings.length ? `<div class="warn"><strong>Avisos:</strong><br>${v.warnings.map(escapeHtml).join('<br>')}</div>` : ''}
    `;
  }

  /* =========================
     ADMIN HELPERS
  ========================= */
  function clearAdminForm() {
    const ids = ['admId','admTitle','admSubtitle','admCover','admTags','admBody','admChecklist','admXp'];
    ids.forEach(x => { const el = $('#'+x); if (el) el.value = ''; });
    const cat = $('#admCategory'); if (cat) cat.value = '';
    const lvl = $('#admLevel'); if (lvl) lvl.value = '';
    const type = $('#admType'); if (type) type.value = 'lesson';
    const sel = $('#admLessonIds'); if (sel) Array.from(sel.options).forEach(o => o.selected = false);
    toggleAdminFields();
  }

  function toggleAdminFields() {
    const type = ($('#admType')?.value || 'lesson').trim();
    const bodyWrap = $('#admBodyWrap');
    const checklistWrap = $('#admChecklistWrap');
    const xpWrap = $('#admXpWrap');
    const lessonIdsWrap = $('#admLessonIdsWrap');

    if (lessonIdsWrap) lessonIdsWrap.style.display = (type === 'track') ? 'block' : 'none';

    if (bodyWrap) bodyWrap.style.display = (type === 'mission' || type === 'track') ? 'none' : 'block';

    if (checklistWrap) checklistWrap.style.display = (type === 'track') ? 'none' : 'block';

    if (xpWrap) xpWrap.style.display = (type === 'mission' || type === 'lesson') ? 'block' : 'none';
  }

  function buildAdminItemFromForm() {
    const type = ($('#admType')?.value || '').trim();
    const id = ($('#admId')?.value || '').trim();
    const title = ($('#admTitle')?.value || '').trim();
    const subtitle = ($('#admSubtitle')?.value || '').trim();
    const cover = ($('#admCover')?.value || '').trim();
    const category = ($('#admCategory')?.value || '').trim();
    const level = ($('#admLevel')?.value || '').trim();
    const tags = ($('#admTags')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const body = ($('#admBody')?.value || '').trim();
    const checklistText = ($('#admChecklist')?.value || '').trim();
    const xp = Number(($('#admXp')?.value || '').trim() || 0);

    if (!type || !id || !title) {
      showToast('Preencha tipo, id e título.');
      return null;
    }

    const base = {
      id, type, title, subtitle, cover, tags, category, level,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      version: 1
    };

    if (type === 'track') {
      const sel = $('#admLessonIds');
      const lessonIds = sel ? Array.from(sel.selectedOptions).map(o => o.value) : [];
      return normalizeItem({ ...base, lessonIds, order: undefined });
    }

    if (type === 'lesson') {
      const checklist = checklistText ? checklistText.split('\n').map(x => x.trim()).filter(Boolean) : [];
      return normalizeItem({ ...base, body, checklist, xp: xp || undefined });
    }

    if (type === 'library') {
      return normalizeItem({ ...base, body, readingMinutes: undefined });
    }

    if (type === 'mission') {
      const steps = checklistText ? checklistText.split('\n').map(x => x.trim()).filter(Boolean) : [];
      return normalizeItem({ ...base, xp: xp || 10, repeat: 'daily', missionKind: '', steps });
    }

    showToast('Tipo inválido.');
    return null;
  }

  function updateAdminPreview() {
    const prev = $('#admPreview');
    if (!prev) return;

    const tmp = buildAdminItemFromFormPreview();
    if (!tmp) {
      prev.innerHTML = `<p class="muted">Preencha o formulário para ver o preview.</p>`;
      return;
    }

    const tagRow = renderTagRow(tmp);
    const body = (tmp.type === 'lesson' || tmp.type === 'library') ? `<div class="md">${renderMarkdown(tmp.body || '')}</div>` : '';
    const extra = tmp.type === 'track'
      ? `<p class="muted">Lições: ${(tmp.lessonIds || []).length}</p>`
      : tmp.type === 'mission'
        ? `<p class="muted">XP: ${tmp.xp}</p>`
        : '';

    prev.innerHTML = `
      <h2 style="margin-bottom:6px">${escapeHtml(tmp.title)}</h2>
      <p class="muted">${escapeHtml(tmp.subtitle || '')}</p>
      ${tagRow}
      ${extra}
      ${body}
    `;
  }

  function buildAdminItemFromFormPreview() {
    // Does not toast; for preview only
    const type = ($('#admType')?.value || '').trim();
    const id = ($('#admId')?.value || '').trim();
    const title = ($('#admTitle')?.value || '').trim();
    if (!type || !id || !title) return null;

    const subtitle = ($('#admSubtitle')?.value || '').trim();
    const cover = ($('#admCover')?.value || '').trim();
    const category = ($('#admCategory')?.value || '').trim();
    const level = ($('#admLevel')?.value || '').trim();
    const tags = ($('#admTags')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const body = ($('#admBody')?.value || '').trim();
    const checklistText = ($('#admChecklist')?.value || '').trim();
    const xp = Number(($('#admXp')?.value || '').trim() || 0);

    const base = { id, type, title, subtitle, cover, tags, category, level };

    if (type === 'track') {
      const sel = $('#admLessonIds');
      const lessonIds = sel ? Array.from(sel.selectedOptions).map(o => o.value) : [];
      return normalizeItem({ ...base, lessonIds });
    }

    if (type === 'lesson') {
      const checklist = checklistText ? checklistText.split('\n').map(x => x.trim()).filter(Boolean) : [];
      return normalizeItem({ ...base, body, checklist, xp: xp || undefined });
    }

    if (type === 'library') {
      return normalizeItem({ ...base, body });
    }

    if (type === 'mission') {
      const steps = checklistText ? checklistText.split('\n').map(x => x.trim()).filter(Boolean) : [];
      return normalizeItem({ ...base, xp: xp || 10, repeat: 'daily', steps });
    }

    return null;
  }

  /* =========================
     SW UPDATE LISTENER
  ========================= */
  function setupSWUpdateListener() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (!event?.data) return;
      if (event.data.type === 'SW_UPDATE_READY') {
        state.ui.swUpdateAvailable = true;
        showToast('Atualização disponível. Recarregue para aplicar.', 4500);
      }
    });
  }

  /* =========================
     INIT
  ========================= */
  async function init(forceReload = false) {
    loadStorage();
    loadAdminBuffer();

    // admin button route
    adminBtn.addEventListener('click', () => navigate('#/admin'));

    // event listeners
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onChange);
    window.addEventListener('hashchange', render);

    setupSWUpdateListener();

    if (forceReload) {
      state.content.loaded = false;
      state.content.items = [];
      state.content.byId = new Map();
    }

    const ok = await loadContent();
    if (!ok) {
      render();
      return;
    }

    // Ensure default route
    if (!location.hash) location.hash = '#/home';
    render();

    // Admin fields toggle after initial render when entering admin
    setTimeout(() => {
      // if admin is opened directly
      if (getRoute().path === '#/admin') {
        toggleAdminFields();
        updateAdminPreview();
      }
    }, 0);
  }

  // Boot
  init();

})();

/* =========================================================
   CSS enhancements injected via JS (small and safe)
   (keeps Part 1 smaller; still full files, no patching runtime)
========================================================= */
(() => {
  const style = document.createElement('style');
  style.textContent = `
    .spacer{height:10px}
    .md h1,.md h2,.md h3{font-family:'Sora',sans-serif;margin:10px 0 6px}
    .md p{color:rgba(244,246,255,0.80);line-height:1.7;margin:8px 0;font-size:14px}
    .md ul{margin:8px 0 8px 18px}
    .md li{margin:6px 0;color:rgba(244,246,255,0.80);line-height:1.65}
    .md code{background:rgba(255,255,255,0.10);padding:2px 6px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
    .chiprow{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .chip{font-size:12px;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:rgba(244,246,255,0.80)}
    .actions-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    .stack{display:flex;flex-direction:column;gap:12px;margin-top:14px}
    .muted{color:rgba(244,246,255,0.65)}
    .hero{display:flex;gap:16px;align-items:stretch}
    .hero-left{flex:1}
    .hero-kicker{color:rgba(244,246,255,0.7);font-size:12px;margin-bottom:6px}
    .hero-right{width:74px;display:flex;align-items:flex-start;justify-content:flex-end}
    .hero-badge{background:rgba(255,176,0,0.18);border:1px solid rgba(255,176,0,0.30);color:#FFB000;padding:8px 10px;border-radius:999px;font-weight:700;font-size:12px}
    .metrics{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0 6px}
    .metric{min-width:92px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);border-radius:14px;padding:10px}
    .metric-label{font-size:11px;color:rgba(244,246,255,0.65)}
    .metric-value{font-size:16px;font-weight:800;color:#F4F6FF;margin-top:2px}
    .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:14px}
    .tile{padding:14px;border-radius:16px;text-align:left;box-shadow:0 10px 20px rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.12)}
    .tile:active{transform:translateY(1px)}
    .tile-title{font-family:'Sora',sans-serif;font-weight:800;font-size:14px}
    .tile-sub{font-size:12px;color:rgba(244,246,255,0.70);margin-top:3px}
    .track-card{display:flex;gap:12px;text-align:left;border-radius:18px;padding:0;overflow:hidden;border:1px solid rgba(255,255,255,0.12);box-shadow:0 14px 30px rgba(0,0,0,0.28);cursor:pointer}
    .track-card:active{transform:translateY(1px)}
    .cover{width:92px;min-height:92px;background-size:cover;background-position:center;background-color:rgba(255,255,255,0.06)}
    .track-body{padding:14px;flex:1}
    .track-title{font-family:'Sora',sans-serif;font-weight:800;font-size:15px}
    .track-sub{font-size:12px;color:rgba(244,246,255,0.70);margin-top:4px}
    .track-meta{display:flex;justify-content:space-between;color:rgba(244,246,255,0.65);font-size:12px;margin-top:10px}
    .lesson-row,.article-row{display:flex;justify-content:space-between;gap:12px;text-align:left;border-radius:18px;padding:14px;border:1px solid rgba(255,255,255,0.12);box-shadow:0 14px 30px rgba(0,0,0,0.20);cursor:pointer}
    .lesson-row:active,.article-row:active{transform:translateY(1px)}
    .lesson-title,.article-title{font-family:'Sora',sans-serif;font-weight:800;font-size:14px}
    .lesson-sub,.article-sub{font-size:12px;color:rgba(244,246,255,0.70);margin-top:4px}
    .pill{padding:8px 10px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid rgba(255,255,255,0.12)}
    .pill-done{background:rgba(47,230,166,0.15);color:#2FE6A6;border-color:rgba(47,230,166,0.28)}
    .pill-pending{background:rgba(255,176,0,0.14);color:#FFB000;border-color:rgba(255,176,0,0.26)}
    .mission-card{margin-bottom:0}
    .mission-head{display:flex;justify-content:space-between;gap:12px}
    .mission-title{font-family:'Sora',sans-serif;font-weight:900;font-size:14px}
    .mission-sub{font-size:12px;color:rgba(244,246,255,0.70);margin-top:4px}
    .mission-xp{font-weight:900;color:#111;background:#FFB000;border-radius:12px;padding:10px 10px;height:fit-content}
    .mini-steps{margin-top:12px;color:rgba(244,246,255,0.75);font-size:12px}
    .mini-step{margin:4px 0}
    .checklist{margin-top:14px}
    .checklist-title{font-family:'Sora',sans-serif;font-weight:900;font-size:14px;margin-bottom:10px}
    .checkline{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:16px;border:1px solid rgba(255,255,255,0.12);margin-bottom:10px}
    .checkline input{margin-top:3px;accent-color:#FFB000}
    .profile-grid{display:grid;gap:12px;margin-top:14px}
    .field-label{font-size:12px;color:rgba(244,246,255,0.65);margin-bottom:6px}
    .input,.textarea,select{width:100%;color:#F4F6FF;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:12px 12px;outline:none}
    .textarea{resize:vertical}
    .row{display:flex;gap:10px;align-items:center}
    .hint{font-size:12px;color:rgba(244,246,255,0.6);margin-top:8px}
    .segmented{display:flex;gap:6px;padding:6px;border-radius:14px;border:1px solid rgba(255,255,255,0.12)}
    .seg-btn{flex:1;background:transparent;border:none;color:rgba(244,246,255,0.75);padding:10px;border-radius:12px;font-weight:900;cursor:pointer}
    .seg-btn.active{background:rgba(255,176,0,0.16);border:1px solid rgba(255,176,0,0.26);color:#FFB000}
    .metrics-profile{margin-top:14px}
    .admin-form{margin-top:14px}
    .admin-preview{margin-top:14px}
    .report{margin-top:12px;font-size:13px;color:rgba(244,246,255,0.78)}
    .ok{color:#2FE6A6;font-weight:900;margin-bottom:6px}
    .bad{color:#FF4D6D;font-weight:900;margin-bottom:6px}
    .warn{color:#FFB000;font-weight:900;margin-top:8px}
    @media(min-width:768px){
      .grid{grid-template-columns:repeat(4,1fr)}
      .profile-grid{grid-template-columns:1fr 1fr}
    }
  `;
  document.head.appendChild(style);
})();
