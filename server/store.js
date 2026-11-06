const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'kanban.json');
const TMP_FILE = DATA_FILE + '.tmp';
const EXAMPLE_FILE = path.join(__dirname, '..', 'examples', 'kanban.json');
const MAX_TEXT = 100000; // long pasted notes are fine; this just stops runaway requests

// Each level of the tree: which array holds its children and which fields a PATCH may change.
const LEVELS = {
  board: { prefix: 'b', children: 'cards', child: 'card', fields: ['name'] },
  card: { prefix: 'c', children: 'tasks', child: 'task', fields: ['title', 'notes', 'color'] },
  task: { prefix: 't', children: 'subtasks', child: 'subtask', fields: ['text', 'done'] },
  subtask: { prefix: 's', children: null, child: null, fields: ['text', 'done'] }
};
const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

let state = null;
let rev = 0;
let lastWrittenMtime = 0;
const listeners = new Set();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function newId(level) {
  return LEVELS[level].prefix + crypto.randomBytes(4).toString('hex');
}

function defaultState() {
  return { version: 1, boards: [makeBoard('Home')] };
}

function makeBoard(name) {
  return { id: newId('board'), name, cards: [] };
}

// ---------- load / save ----------

// Fills in anything missing so a hand-edited file with only names/titles still works.
function normalize(data) {
  if (!data || !Array.isArray(data.boards)) throw new Error('expected { "boards": [...] }');
  const seen = new Set();
  const fix = (item, level) => {
    if (!item || typeof item !== 'object') throw new Error(`${level} is not an object`);
    if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) item.id = newId(level);
    seen.add(item.id);
    const { children, child } = LEVELS[level];
    if (level === 'board') item.name = String(item.name ?? 'Untitled');
    if (level === 'card') {
      item.title = String(item.title ?? '');
      item.notes = String(item.notes ?? '');
      if (!COLORS.includes(item.color)) item.color = null;
    }
    if (level === 'task' || level === 'subtask') {
      item.text = String(item.text ?? '');
      item.done = Boolean(item.done);
    }
    // ext is the id another app (Voice Notes) gave a task; only keep usable values.
    if (level === 'task' && 'ext' in item && (typeof item.ext !== 'string' || !item.ext)) delete item.ext;
    if (children) {
      if (!Array.isArray(item[children])) item[children] = [];
      item[children].forEach((c) => fix(c, child));
    }
  };
  data.boards.forEach((b) => fix(b, 'board'));
  if (!data.boards.length) data.boards.push(makeBoard('Home'));
  data.version = 1;
  return data;
}

function readFile() {
  return normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
}

function save() {
  // Write-then-rename so a crash mid-write never leaves a half-written file behind.
  fs.writeFileSync(TMP_FILE, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(TMP_FILE, DATA_FILE);
  lastWrittenMtime = fs.statSync(DATA_FILE).mtimeMs;
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    state = readFile();
  } else if (fs.existsSync(EXAMPLE_FILE)) {
    // First run: start with the demo boards so every feature is visible straight away.
    state = normalize(JSON.parse(fs.readFileSync(EXAMPLE_FILE, 'utf8')));
  } else {
    state = defaultState();
  }
  save();
  // Starts from the clock so revisions keep increasing across restarts.
  rev = Date.now();

  // Pick up edits made to the file by hand (or by another tool) while the server runs.
  fs.watchFile(DATA_FILE, { interval: 1000 }, (curr) => {
    if (!curr.mtimeMs || curr.mtimeMs === lastWrittenMtime) return;
    try {
      state = readFile();
      lastWrittenMtime = curr.mtimeMs;
      changed();
      console.log('Reloaded kanban.json after an outside edit');
    } catch (err) {
      console.error(`Ignoring outside edit to kanban.json: ${err.message}`);
    }
  });
}

function changed() {
  rev++;
  for (const fn of listeners) fn(rev);
}

function commit() {
  save();
  changed();
  return snapshot();
}

function snapshot() {
  return { rev, boards: state.boards };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- lookups ----------

// Walks the whole tree; small enough that an index isn't worth keeping in sync.
function find(id) {
  const walk = (list, level, parent) => {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.id === id) return { item, level, list, index: i, parent };
      const { children, child } = LEVELS[level];
      if (children) {
        const hit = walk(item[children], child, item);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(state.boards, 'board', null);
}

function mustFind(id, level) {
  const hit = find(id);
  if (!hit || (level && hit.level !== level)) throw new HttpError(404, `${level || 'item'} not found`);
  return hit;
}

function cleanText(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const text = value.trim().slice(0, MAX_TEXT);
  if (!text && !allowEmpty) throw new HttpError(400, `${field} is required`);
  return text;
}

// ---------- mutations ----------

function addBoard(name) {
  state.boards.push(makeBoard(cleanText(name, 'name')));
  return commit();
}

function addChild(parentId, parentLevel, text) {
  const { item } = mustFind(parentId, parentLevel);
  const { children, child } = LEVELS[parentLevel];
  const entry = { id: newId(child) };
  if (child === 'card') Object.assign(entry, { title: cleanText(text, 'title'), notes: '', color: null, tasks: [] });
  if (child === 'task') Object.assign(entry, { text: cleanText(text, 'text'), done: false, subtasks: [] });
  if (child === 'subtask') Object.assign(entry, { text: cleanText(text, 'text'), done: false });
  item[children].push(entry);
  return commit();
}

function update(id, patch) {
  const { item, level, parent } = mustFind(id);
  const allowed = LEVELS[level].fields;
  const keys = Object.keys(patch || {}).filter((k) => allowed.includes(k));
  if (!keys.length) throw new HttpError(400, `nothing to update; ${level} accepts ${allowed.join(', ')}`);
  for (const key of keys) {
    const value = patch[key];
    if (key === 'done') {
      if (typeof value !== 'boolean') throw new HttpError(400, 'done must be true or false');
      item.done = value;
      // A task and its subtasks stay in step: ticking a task ticks everything under it, and
      // a task is done exactly when all of its subtasks are.
      if (level === 'task') for (const s of item.subtasks) s.done = value;
      if (level === 'subtask') parent.done = parent.subtasks.every((s) => s.done);
    } else if (key === 'color') {
      if (value !== null && !COLORS.includes(value)) throw new HttpError(400, `color must be null or one of ${COLORS.join(', ')}`);
      item.color = value;
    } else {
      item[key] = cleanText(value, key, { allowEmpty: key === 'notes' });
    }
  }
  return commit();
}

function remove(id) {
  const { list, index, level } = mustFind(id);
  if (level === 'board' && state.boards.length === 1) throw new HttpError(400, "can't delete the last board");
  list.splice(index, 1);
  return commit();
}

// Moves an item to position `index` under `parentId` (omit parentId for boards).
function move(id, parentId, index) {
  const hit = mustFind(id);
  let target;
  if (hit.level === 'board') {
    target = state.boards;
  } else {
    const parentLevel = Object.keys(LEVELS).find((l) => LEVELS[l].child === hit.level);
    const parent = mustFind(parentId, parentLevel);
    target = parent.item[LEVELS[parentLevel].children];
  }
  hit.list.splice(hit.index, 1);
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, target.length)) : target.length;
  target.splice(i, 0, hit.item);
  return commit();
}

// Drops checked-off tasks from a card, and checked-off subtasks from the tasks that remain.
function clearCompleted(cardId) {
  const { item } = mustFind(cardId, 'card');
  item.tasks = item.tasks.filter((t) => !t.done);
  for (const t of item.tasks) t.subtasks = t.subtasks.filter((s) => !s.done);
  return commit();
}

// ---------- integration API (/api/v1) ----------
// Small find-or-create and upsert helpers for other apps. They return just the item they
// touched instead of the whole snapshot, and only save when something actually changed.

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

function boardSummary(board) {
  return { id: board.id, name: board.name, cards: board.cards.map((c) => ({ id: c.id, title: c.title })) };
}

function getBoard(id) {
  return boardSummary(mustFind(id, 'board').item);
}

function boardByName(name) {
  const clean = cleanText(name, 'name');
  let board = state.boards.find((b) => sameName(b.name, clean));
  if (!board) {
    board = makeBoard(clean);
    state.boards.push(board);
    commit();
  }
  return boardSummary(board);
}

function cardByTitle(boardId, title) {
  const { item: board } = mustFind(boardId, 'board');
  const clean = cleanText(title, 'title');
  let card = board.cards.find((c) => sameName(c.title, clean));
  if (!card) {
    card = { id: newId('card'), title: clean, notes: '', color: null, tasks: [] };
    board.cards.push(card);
    commit();
  }
  return { id: card.id, title: card.title };
}

function findExt(board, ext) {
  for (const card of board.cards) {
    const index = card.tasks.findIndex((t) => t.ext === ext);
    if (index !== -1) return { card, index, task: card.tasks[index] };
  }
  return null;
}

// Creates or updates the task with this ext anywhere on the board. A task already in
// cardId keeps its place and done state; one in another card moves to cardId at position.
function upsertTask(boardId, ext, { cardId, text, position } = {}) {
  const { item: board } = mustFind(boardId, 'board');
  const key = cleanText(ext, 'ext');
  if (typeof cardId !== 'string') throw new HttpError(400, 'cardId must be a string');
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new HttpError(404, 'card not found on this board');
  const clean = cleanText(text, 'text');
  if (position !== undefined && position !== 'top' && position !== 'bottom') {
    throw new HttpError(400, "position must be 'top' or 'bottom'");
  }
  const insert = (task) => (position === 'top' ? card.tasks.unshift(task) : card.tasks.push(task));

  const hit = findExt(board, key);
  if (!hit) {
    insert({ id: newId('task'), text: clean, done: false, subtasks: [], ext: key });
    const task = card.tasks[position === 'top' ? 0 : card.tasks.length - 1];
    commit();
    return { id: task.id, ext: key, cardId: card.id, created: true };
  }
  let dirty = false;
  if (hit.card !== card) {
    hit.card.tasks.splice(hit.index, 1);
    insert(hit.task);
    dirty = true;
  }
  if (hit.task.text !== clean) {
    hit.task.text = clean;
    dirty = true;
  }
  if (dirty) commit();
  return { id: hit.task.id, ext: key, cardId: card.id, created: false };
}

// Idempotent: deleting an ext that isn't there is fine. The board must exist, though.
function removeTaskByExt(boardId, ext) {
  const { item: board } = mustFind(boardId, 'board');
  const hit = findExt(board, String(ext).trim());
  if (!hit) return false;
  hit.card.tasks.splice(hit.index, 1);
  commit();
  return true;
}

module.exports = {
  init,
  getBoard,
  boardByName,
  cardByTitle,
  upsertTask,
  removeTaskByExt,
  snapshot,
  subscribe,
  addBoard,
  addChild,
  update,
  remove,
  move,
  clearCompleted,
  HttpError,
  DATA_DIR,
  COLORS
};
