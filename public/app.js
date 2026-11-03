'use strict';

const STATE_KEY = 'kanban.state';
const BOARD_KEY = 'kanban.board';
const OPEN_KEY = 'kanban.open';
const OFFLINE_MSG = "You're offline, so that change wasn't saved.";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// localStorage can throw (private mode, storage disabled); the app works without it.
function loadLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function saveLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

let data = loadLocal(STATE_KEY); // { rev, boards, colors }
let currentBoardId = loadLocal(BOARD_KEY);
let openTasks = loadLocal(OPEN_KEY) || {}; // taskId -> expanded; unset = expanded when it has subtasks
let authRequired = null; // unknown until the server answers
let offline = false;
let retryTimer = null;
let dragging = false;
let pendingRender = false;
let events = null;

// ---------- server ----------

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    setOffline(true);
    throw new Error('offline');
  }
  setOffline(false);
  if (res.status === 401 && !url.startsWith('/api/login')) {
    showLogin();
    throw new Error('login required');
  }
  const payload = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload;
}

// Sends a change and redraws from the state the server returns.
async function mutate(method, url, body) {
  if (offline) {
    toast(OFFLINE_MSG);
    render();
    return;
  }
  try {
    apply(await api(method, url, body));
  } catch (err) {
    if (err.message === 'offline') toast(OFFLINE_MSG);
    else if (err.message !== 'login required') toast(err.message);
    render(); // undo whatever the page already showed
  }
}

function apply(next) {
  if (!next || !Array.isArray(next.boards)) return;
  if (data && next.rev < data.rev) return; // an older response arriving late
  data = { ...next, colors: next.colors || data?.colors || [] };
  saveLocal(STATE_KEY, data);
  pruneOpenTasks();
  render();
}

async function refresh() {
  try {
    if (authRequired === null) authRequired = (await api('GET', '/api/auth')).required;
    apply(await api('GET', '/api/state'));
    connectEvents();
  } catch {}
}

// The server pushes its revision after every change; refetch when it's newer than ours.
function connectEvents() {
  if (events || !window.EventSource) return;
  events = new EventSource('/api/events');
  events.onmessage = (e) => {
    if (!data || Number(e.data) > data.rev) refresh();
  };
  events.onerror = () => {
    // A closed stream (server gone, or 401) isn't retried by the browser; refresh() reconnects.
    if (events.readyState === EventSource.CLOSED) {
      events = null;
      setTimeout(refresh, 5000);
    }
  };
}

function setOffline(value) {
  if (offline === value) return;
  offline = value;
  $('#offline').hidden = !offline;
  document.body.classList.toggle('offline', offline);
  clearInterval(retryTimer);
  if (offline) retryTimer = setInterval(refresh, 10 * 1000);
  updateSortables();
}

// ---------- lookups ----------

function currentBoard() {
  if (!data) return null;
  return data.boards.find((b) => b.id === currentBoardId) || data.boards[0];
}

function findItem(id) {
  for (const board of data.boards) {
    if (board.id === id) return board;
    for (const card of board.cards) {
      if (card.id === id) return card;
      for (const task of card.tasks) {
        if (task.id === id) return task;
        for (const sub of task.subtasks) if (sub.id === id) return sub;
      }
    }
  }
  return null;
}

function isOpen(task) {
  return task.id in openTasks ? openTasks[task.id] : task.subtasks.length > 0;
}

function pruneOpenTasks() {
  for (const id of Object.keys(openTasks)) if (!findItem(id)) delete openTasks[id];
  saveLocal(OPEN_KEY, openTasks);
}

// ---------- rendering ----------

function tabsHtml(board) {
  return data.boards
    .map((b) => `<button class="tab${b.id === board.id ? ' active' : ''}" type="button" data-id="${b.id}">${esc(b.name)}</button>`)
    .join('');
}

function subtaskHtml(sub) {
  return `<li class="subtask${sub.done ? ' done' : ''}" data-id="${sub.id}">
    <span class="grip sub-grip" aria-hidden="true"></span>
    <input type="checkbox" class="check" aria-label="Done"${sub.done ? ' checked' : ''}>
    <span class="text" data-edit="text">${esc(sub.text)}</span>
    <button class="icon-btn small" type="button" data-action="delete-subtask" aria-label="Delete">×</button>
  </li>`;
}

function taskHtml(task) {
  const open = isOpen(task);
  const total = task.subtasks.length;
  const done = task.subtasks.filter((s) => s.done).length;
  const toggle = total
    ? `<span class="count">${done}/${total}</span><span class="chevron" aria-hidden="true"></span>`
    : '<span class="plus" aria-hidden="true">+</span>';
  return `<li class="task${task.done ? ' done' : ''}${open ? ' open' : ''}" data-id="${task.id}">
    <div class="row">
      <span class="grip task-grip" aria-hidden="true"></span>
      <input type="checkbox" class="check" aria-label="Done"${task.done ? ' checked' : ''}>
      <span class="text" data-edit="text">${esc(task.text)}</span>
      <button class="expand" type="button" data-action="expand" aria-expanded="${open}" aria-label="${total ? 'Subtasks' : 'Add subtasks'}">${toggle}</button>
    </div>
    ${open ? `<div class="sub">
      <ul class="subtasks" data-parent="${task.id}">${task.subtasks.map(subtaskHtml).join('')}</ul>
      <form class="add add-sub" data-kind="subtask" data-parent="${task.id}">
        <input data-key="sub:${task.id}" placeholder="Add subtask" enterkeyhint="enter" autocomplete="off">
      </form>
      <button class="link danger" type="button" data-action="delete-task">Delete task</button>
    </div>` : ''}
  </li>`;
}

function cardHtml(card) {
  const total = card.tasks.length;
  const done = card.tasks.filter((t) => t.done).length;
  return `<article class="card" data-id="${card.id}"${card.color ? ` data-color="${card.color}"` : ''}>
    <header class="card-head">
      <span class="grip card-grip" aria-hidden="true"></span>
      <h2 class="card-title" data-edit="title">${esc(card.title)}</h2>
      ${total ? `<span class="count">${done}/${total}</span>` : ''}
      <button class="icon-btn" type="button" data-action="card-menu" aria-label="Card options">⋯</button>
    </header>
    ${card.notes ? `<p class="notes" data-action="edit-notes">${esc(card.notes)}</p>` : ''}
    <ul class="tasks" data-parent="${card.id}">${card.tasks.map(taskHtml).join('')}</ul>
    <form class="add add-task" data-kind="task" data-parent="${card.id}">
      <input data-key="task:${card.id}" placeholder="Add task" enterkeyhint="enter" autocomplete="off">
    </form>
  </article>`;
}

function cardsHtml(board) {
  return board.cards.map(cardHtml).join('') + `<form class="add add-card" data-kind="card" data-parent="${board.id}">
    <input data-key="card:${board.id}" placeholder="+ New card" enterkeyhint="done" autocomplete="off">
  </form>`;
}

// Patches the page in place (keyed by data-id/data-key) instead of rebuilding it, so focused
// inputs and the on-screen keyboard survive updates.
const morphOptions = {
  childrenOnly: true,
  getNodeKey: (node) => (node.dataset && (node.dataset.id || node.dataset.key)) || node.id,
  onBeforeElUpdated: (from) => !(from.matches('input[data-key]') || from.isContentEditable)
};

function isEditing() {
  return Boolean(document.activeElement?.isContentEditable);
}

function render() {
  if (!data) return;
  if (dragging || isEditing()) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const board = currentBoard();
  if (currentBoardId !== board.id) {
    currentBoardId = board.id;
    saveLocal(BOARD_KEY, currentBoardId);
  }
  document.title = `${board.name} · Kanban`;
  morphdom($('#tabs'), `<nav>${tabsHtml(board)}</nav>`, morphOptions);
  morphdom($('#cards'), `<main>${cardsHtml(board)}</main>`, morphOptions);
  $('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateSortables();
}

function flushRender() {
  if (pendingRender) render();
}

// ---------- drag and drop ----------

function sortable(el, options) {
  const existing = Sortable.get(el);
  if (existing) {
    existing.option('disabled', offline);
    return;
  }
  Sortable.create(el, {
    animation: 150,
    disabled: offline,
    emptyInsertThreshold: 24,
    onStart: (evt) => {
      dragging = true;
      document.body.dataset.dragging = evt.item.className.split(' ')[0];
    },
    onEnd: onDrop,
    ...options
  });
}

function updateSortables() {
  sortable($('#tabs'), { draggable: '.tab', direction: 'horizontal', delay: 250, delayOnTouchOnly: true });
  sortable($('#cards'), { draggable: '.card', handle: '.card-grip' });
  // Nested lists let dragover bubble, or a card dragged across another card's tasks would stall.
  $$('.tasks').forEach((el) => sortable(el, { group: 'tasks', draggable: '.task', handle: '.task-grip', dragoverBubble: true }));
  $$('.subtasks').forEach((el) => sortable(el, { group: 'subtasks', draggable: '.subtask', handle: '.sub-grip', dragoverBubble: true }));
}

function onDrop(evt) {
  dragging = false;
  delete document.body.dataset.dragging;
  if (evt.from === evt.to && evt.oldDraggableIndex === evt.newDraggableIndex) {
    flushRender();
    return;
  }
  mutate('POST', `/api/items/${evt.item.dataset.id}/move`, {
    parentId: evt.to.id === 'cards' ? currentBoard().id : evt.to.dataset.parent,
    index: evt.newDraggableIndex
  });
}

// ---------- inline editing ----------

function startEdit(el) {
  if (offline || el.isContentEditable) return;
  el.dataset.original = el.textContent;
  try {
    el.contentEditable = 'plaintext-only';
  } catch {
    el.contentEditable = 'true';
  }
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

async function finishEdit(el, cancel) {
  const original = el.dataset.original;
  const text = el.textContent.replace(/[ \t]+/g, ' ').trim(); // keep line breaks from multi-line notes
  el.removeAttribute('contenteditable');
  delete el.dataset.original;
  const id = el.closest('[data-id]').dataset.id;
  if (cancel || text === original) {
    el.textContent = original;
    flushRender();
    return;
  }
  if (!text) {
    // Clearing a task or subtask deletes it; titles just snap back.
    el.textContent = original;
    if (el.dataset.edit === 'text' && (await confirmDelete(findItem(id)))) mutate('DELETE', `/api/items/${id}`);
    else flushRender();
    return;
  }
  mutate('PATCH', `/api/items/${id}`, { [el.dataset.edit]: text });
}

// ---------- sheets (menus and prompts) ----------

const sheetEl = $('#sheet');
sheetEl.addEventListener('click', (e) => {
  if (e.target === sheetEl) sheetEl.close('');
  if (e.target.closest('[data-cancel]')) sheetEl.close('');
});

// Shows a modal; resolves with the clicked button's value (or null) and the text field, if any.
function sheet({ title, body = '', actions = [] }) {
  sheetEl.innerHTML = `<form method="dialog" class="sheet-box">
    ${title ? `<h3>${esc(title)}</h3>` : ''}
    ${body}
    <div class="sheet-actions">
      ${actions.map((a) => `<button value="${esc(a.value)}" class="${a.danger ? 'danger' : ''}${a.primary ? ' primary' : ''}"${a.disabled ? ' disabled' : ''}>${esc(a.label)}</button>`).join('')}
      <button type="button" data-cancel>Cancel</button>
    </div>
  </form>`;
  return new Promise((resolve) => {
    sheetEl.onclose = () => {
      const field = $('[name=text]', sheetEl);
      resolve({ value: sheetEl.returnValue || null, text: field ? field.value : null });
    };
    sheetEl.returnValue = '';
    sheetEl.showModal();
    const field = $('[name=text]', sheetEl);
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  });
}

async function askText(title, value = '', { multiline = false, placeholder = '', label = 'Save' } = {}) {
  const field = multiline
    ? `<textarea name="text" rows="5" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input name="text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">`;
  const { value: choice, text } = await sheet({ title, body: field, actions: [{ label, value: 'ok', primary: true }] });
  return choice === 'ok' ? text : null;
}

async function confirmSheet(title, label = 'Delete') {
  const { value } = await sheet({ title, actions: [{ label, value: 'ok', danger: true }] });
  return value === 'ok';
}

// Items with children ask first; a lone task or subtask goes straight away.
async function confirmDelete(item) {
  if (!item) return false;
  if (item.subtasks?.length) return confirmSheet(`Delete "${item.text}" and its ${item.subtasks.length} subtasks?`);
  if (item.tasks?.length) return confirmSheet(`Delete "${item.title}" and its ${item.tasks.length} tasks?`);
  if (item.cards) return confirmSheet(`Delete the "${item.name}" board${item.cards.length ? ` and its ${item.cards.length} cards` : ''}?`);
  return true;
}

async function cardMenu(card) {
  const swatches = [null, ...data.colors]
    .map((c) => `<button class="swatch${card.color === c ? ' active' : ''}" value="color:${c || ''}" ${c ? `data-color="${c}"` : ''} aria-label="${c || 'No colour'}"></button>`)
    .join('');
  const others = data.boards.filter((b) => !currentBoard() || b.id !== currentBoard().id);
  const { value } = await sheet({
    title: card.title,
    body: `<div class="swatches">${swatches}</div>`,
    actions: [
      { label: 'Rename', value: 'rename' },
      { label: card.notes ? 'Edit notes' : 'Add notes', value: 'notes' },
      { label: 'Move to board…', value: 'move', disabled: !others.length },
      { label: 'Clear completed', value: 'clear', disabled: !card.tasks.some((t) => t.done || t.subtasks.some((s) => s.done)) },
      { label: 'Delete card', value: 'delete', danger: true }
    ]
  });
  if (!value) return;
  if (value.startsWith('color:')) return mutate('PATCH', `/api/items/${card.id}`, { color: value.slice(6) || null });
  if (value === 'rename') {
    const title = await askText('Rename card', card.title);
    if (title?.trim()) mutate('PATCH', `/api/items/${card.id}`, { title });
  }
  if (value === 'notes') editNotes(card);
  if (value === 'move') {
    const { value: boardId } = await sheet({
      title: `Move "${card.title}" to…`,
      actions: others.map((b) => ({ label: b.name, value: b.id }))
    });
    if (boardId) mutate('POST', `/api/items/${card.id}/move`, { parentId: boardId });
  }
  if (value === 'clear') mutate('POST', `/api/cards/${card.id}/clear-completed`);
  if (value === 'delete' && (await confirmDelete(card))) mutate('DELETE', `/api/items/${card.id}`);
}

async function editNotes(card) {
  const notes = await askText(`Notes for "${card.title}"`, card.notes, { multiline: true, placeholder: 'Anything worth remembering' });
  if (notes !== null) mutate('PATCH', `/api/items/${card.id}`, { notes });
}

async function boardMenu() {
  const board = currentBoard();
  if (!board) return;
  const actions = [
    { label: 'Rename board', value: 'rename' },
    { label: 'Delete board', value: 'delete', danger: true, disabled: data.boards.length < 2 }
  ];
  if (authRequired) actions.push({ label: 'Log out', value: 'logout' });
  const { value } = await sheet({ title: board.name, actions });
  if (value === 'rename') {
    const name = await askText('Rename board', board.name);
    if (name?.trim()) mutate('PATCH', `/api/items/${board.id}`, { name });
  }
  if (value === 'delete' && (await confirmDelete(board))) mutate('DELETE', `/api/items/${board.id}`);
  if (value === 'logout') logout();
}

async function addBoard() {
  if (offline) return toast(OFFLINE_MSG);
  const name = await askText('New board', '', { placeholder: 'Board name', label: 'Create' });
  if (!name?.trim()) return;
  const before = new Set(data.boards.map((b) => b.id));
  await mutate('POST', '/api/boards', { name });
  const created = data.boards.find((b) => !before.has(b.id));
  if (created) switchBoard(created.id);
}

function switchBoard(id) {
  currentBoardId = id;
  saveLocal(BOARD_KEY, id);
  render();
  window.scrollTo(0, 0);
}

// ---------- events ----------

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchBoard(tab.dataset.id);
});
$('#add-board').addEventListener('click', addBoard);
$('#board-menu').addEventListener('click', boardMenu);

const cardsEl = $('#cards');

cardsEl.addEventListener('click', (e) => {
  const editable = e.target.closest('[data-edit]');
  if (editable) return startEdit(editable);
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const id = button.closest('[data-id]').dataset.id;
  const item = findItem(id);
  if (!item) return;
  switch (button.dataset.action) {
    case 'expand':
      openTasks[id] = !isOpen(item);
      saveLocal(OPEN_KEY, openTasks);
      render();
      if (openTasks[id] && !item.subtasks.length) $(`[data-key="sub:${id}"]`)?.focus();
      break;
    case 'card-menu':
      if (!offline) cardMenu(item);
      break;
    case 'edit-notes':
      if (!offline) editNotes(item);
      break;
    case 'delete-task':
    case 'delete-subtask':
      confirmDelete(item).then((ok) => ok && mutate('DELETE', `/api/items/${id}`));
      break;
  }
});

cardsEl.addEventListener('change', (e) => {
  if (!e.target.matches('.check')) return;
  const id = e.target.closest('[data-id]').dataset.id;
  const item = findItem(id);
  if (!item) return;
  // Show it right away (with the same task/subtask cascade the server applies); the server's copy replaces it.
  item.done = e.target.checked;
  if (item.subtasks) for (const s of item.subtasks) s.done = item.done;
  const parent = item.subtasks ? null : findItem(e.target.closest('.task')?.dataset.id);
  if (parent) parent.done = parent.subtasks.every((s) => s.done);
  render();
  mutate('PATCH', `/api/items/${id}`, { done: e.target.checked });
});

cardsEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const input = $('input', form);
  const text = input.value.trim();
  if (!text) return;
  if (offline) return toast(OFFLINE_MSG);
  input.value = ''; // keep focus so the next item can be typed straight away
  const { kind, parent } = form.dataset;
  if (kind === 'card') mutate('POST', `/api/boards/${parent}/cards`, { title: text });
  if (kind === 'task') mutate('POST', `/api/cards/${parent}/tasks`, { text });
  if (kind === 'subtask') mutate('POST', `/api/tasks/${parent}/subtasks`, { text });
});

cardsEl.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!el.isContentEditable) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    el.blur();
  } else if (e.key === 'Escape') {
    el.dataset.cancel = '1';
    el.blur();
  }
});

cardsEl.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el.isContentEditable || !('original' in el.dataset)) return;
  const cancel = el.dataset.cancel === '1';
  delete el.dataset.cancel;
  finishEdit(el, cancel);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
window.addEventListener('online', refresh);

// ---------- login ----------

function showLogin() {
  $('#login').hidden = false;
  $('#login-password').focus();
  if (events) {
    events.close();
    events = null;
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#login-error');
  error.hidden = true;
  try {
    await api('POST', '/api/login', { password: $('#login-password').value });
    $('#login').hidden = true;
    $('#login-password').value = '';
    refresh();
  } catch (err) {
    error.textContent = err.message === 'offline' ? "Can't reach the server." : err.message;
    error.hidden = false;
  }
});

async function logout() {
  try {
    await api('POST', '/api/logout');
  } catch {}
  // Don't leave the boards readable on this device after logging out.
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {}
  data = null;
  morphdom($('#tabs'), '<nav></nav>', morphOptions);
  morphdom($('#cards'), '<main></main>', morphOptions);
  showLogin();
}

// ---------- misc ----------

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

async function boot() {
  render(); // last saved copy first, so the app opens instantly
  refresh();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
