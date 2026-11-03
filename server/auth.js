const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const SECRET_FILE = path.join(DATA_DIR, '.secret');
const COOKIE = 'kanban_session';
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const FAIL_DELAY_MS = 1000;

let key = null;

function password() {
  return process.env.APP_PASSWORD || '';
}

function enabled() {
  return password() !== '';
}

// The signing key mixes a per-install secret with the password, so changing
// APP_PASSWORD logs out every existing session.
function init() {
  if (!enabled()) return;
  let secret;
  try {
    secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    secret = '';
  }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
  }
  key = crypto.createHash('sha256').update(secret + '\0' + password()).digest();
}

function sign(value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function validSession(req) {
  const raw = readCookie(req);
  if (!raw) return false;
  const [issued, sig] = raw.split('.');
  if (!issued || !sig || !safeEqual(sig, sign(issued))) return false;
  return Date.now() - Number(issued) < MAX_AGE_MS;
}

function setCookie(req, res, value, maxAge) {
  res.cookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge,
    path: '/'
  });
}

// Guards everything under /api except the login endpoints themselves.
function middleware(req, res, next) {
  if (!enabled() || validSession(req)) return next();
  res.status(401).json({ error: 'login required' });
}

function routes(app) {
  app.get('/api/auth', (req, res) => {
    res.json({ required: enabled(), loggedIn: !enabled() || validSession(req) });
  });

  app.post('/api/login', (req, res) => {
    if (!enabled()) return res.status(204).end();
    const given = typeof req.body?.password === 'string' ? req.body.password : '';
    // Compare hashes so the timing doesn't leak the password's length.
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    if (!safeEqual(hash(given), hash(password()))) {
      return setTimeout(() => res.status(401).json({ error: 'wrong password' }), FAIL_DELAY_MS);
    }
    const issued = String(Date.now());
    setCookie(req, res, `${issued}.${sign(issued)}`, MAX_AGE_MS);
    res.status(204).end();
  });

  app.post('/api/logout', (req, res) => {
    setCookie(req, res, '', 0);
    res.status(204).end();
  });
}

module.exports = { init, middleware, routes };
