const express = require('express');
const path = require('path');
const store = require('./store');
const auth = require('./auth');

store.init();
auth.init();

const app = express();
// Behind Caddy: trust X-Forwarded-Proto so req.secure (and the Secure cookie flag) is right.
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Browser builds served straight out of node_modules, so there's no build step.
const VENDOR = {
  'sortable.min.js': 'sortablejs/Sortable.min.js',
  'morphdom.min.js': 'morphdom/dist/morphdom-umd.min.js'
};
app.get('/vendor/:file', (req, res, next) => {
  const target = VENDOR[req.params.file];
  if (!target) return next();
  res.sendFile(require.resolve(target));
});

auth.routes(app);
app.use('/api', auth.middleware);

app.get('/api/state', (req, res) => {
  res.json({ ...store.snapshot(), colors: store.COLORS });
});

// Pushes the revision number after every change so other open devices know to refetch.
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  const send = (rev) => res.write(`data: ${rev}\n\n`);
  send(store.snapshot().rev);
  const unsubscribe = store.subscribe(send);
  // Comment lines keep proxies from closing an idle stream.
  const ping = setInterval(() => res.write(': ping\n\n'), 25 * 1000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

app.post('/api/boards', (req, res) => {
  res.status(201).json(store.addBoard(req.body?.name));
});

app.post('/api/boards/:id/cards', (req, res) => {
  res.status(201).json(store.addChild(req.params.id, 'board', req.body?.title));
});

app.post('/api/cards/:id/tasks', (req, res) => {
  res.status(201).json(store.addChild(req.params.id, 'card', req.body?.text));
});

app.post('/api/cards/:id/clear-completed', (req, res) => {
  res.json(store.clearCompleted(req.params.id));
});

app.post('/api/tasks/:id/subtasks', (req, res) => {
  res.status(201).json(store.addChild(req.params.id, 'task', req.body?.text));
});

// Any board, card, task or subtask by id; ids are unique across the whole file.
app.patch('/api/items/:id', (req, res) => {
  res.json(store.update(req.params.id, req.body));
});

app.delete('/api/items/:id', (req, res) => {
  res.json(store.remove(req.params.id));
});

app.post('/api/items/:id/move', (req, res) => {
  const { parentId, index } = req.body || {};
  res.json(store.move(req.params.id, parentId, index));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof store.HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = Number(process.env.PORT) || 4050;
app.listen(port, () => {
  console.log(`kanban listening on :${port}`);
});
