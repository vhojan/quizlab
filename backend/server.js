'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const Database  = require('better-sqlite3');
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const cors      = require('cors');
const crypto    = require('crypto');

// ── Config ───────────────────────────────────────────────────────────────────
const PORT    = process.env.PORT    || 3000;
const DB_PATH = process.env.DB_PATH || '/data/quizlab.db';

// ── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    desc        TEXT DEFAULT '',
    cover_emoji TEXT DEFAULT '🧠',
    created_at  INTEGER DEFAULT (unixepoch()),
    updated_at  INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS questions (
    id         TEXT PRIMARY KEY,
    quiz_id    TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL DEFAULT 0,
    text       TEXT NOT NULL,
    option_a   TEXT NOT NULL DEFAULT '',
    option_b   TEXT NOT NULL DEFAULT '',
    option_c   TEXT NOT NULL DEFAULT '',
    option_d   TEXT NOT NULL DEFAULT '',
    correct    INTEGER NOT NULL DEFAULT 0,
    time_limit INTEGER NOT NULL DEFAULT 20,
    points     INTEGER NOT NULL DEFAULT 1000,
    is_open    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS games (
    id         TEXT PRIMARY KEY,
    quiz_id    TEXT NOT NULL REFERENCES quizzes(id),
    pin        TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL DEFAULT 'lobby',
    cur_q_idx  INTEGER DEFAULT -1,
    started_at INTEGER,
    ended_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS players (
    id        TEXT PRIMARY KEY,
    game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    email     TEXT NOT NULL,
    score     INTEGER NOT NULL DEFAULT 0,
    joined_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS answers (
    id          TEXT PRIMARY KEY,
    game_id     TEXT NOT NULL,
    question_id TEXT NOT NULL,
    player_id   TEXT NOT NULL,
    answer_idx  INTEGER,
    answer_text TEXT,
    is_correct  INTEGER NOT NULL DEFAULT 0,
    points      INTEGER NOT NULL DEFAULT 0,
    elapsed_ms  INTEGER NOT NULL DEFAULT 0,
    UNIQUE(game_id, question_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ── Bootstrap: auto-generate host password if not set ────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, value);
}

// Password: env var takes priority, then DB, then auto-generate
let HOST_PASSWORD_PLAIN = process.env.HOST_PASSWORD || null;
let HOST_PASSWORD_HASH  = getSetting('host_password_hash');

if (!HOST_PASSWORD_HASH) {
  // First boot
  if (!HOST_PASSWORD_PLAIN) {
    HOST_PASSWORD_PLAIN = crypto.randomBytes(5).toString('hex'); // e.g. "a3f9b2e1c4"
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  AUTO-GENERATED HOST PASSWORD             ║');
    console.log(`║  Password: ${HOST_PASSWORD_PLAIN.padEnd(30)}║`);
    console.log('║  Save this — you can change it in Settings║');
    console.log('╚══════════════════════════════════════════╝\n');
  }
  HOST_PASSWORD_HASH = bcrypt.hashSync(HOST_PASSWORD_PLAIN, 10);
  setSetting('host_password_hash', HOST_PASSWORD_HASH);
} else if (HOST_PASSWORD_PLAIN) {
  // Env var override — re-hash and store
  HOST_PASSWORD_HASH = bcrypt.hashSync(HOST_PASSWORD_PLAIN, 10);
  setSetting('host_password_hash', HOST_PASSWORD_HASH);
}

// Default settings
const DEFAULTS = {
  default_time_limit:    '20',
  leaderboard_every:     '5',
  leaderboard_size:      '10',
  final_leaderboard_size:'5',
  logo_base64:           '',
  logo_mime:             '',
};
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (getSetting(k) === null) setSetting(k, v);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  return s;
}

// ── Auth token ────────────────────────────────────────────────────────────────
// Token is derived at runtime from the stored hash — changes on password change
function makeToken(hash) {
  return 'ql_' + crypto.createHash('sha256').update(hash).digest('hex').slice(0, 24);
}
let HOST_TOKEN = makeToken(HOST_PASSWORD_HASH);

function verifyToken(tok) { return tok === HOST_TOKEN; }
function requireHost(req, res, next) {
  const tok = req.headers['x-host-token'] || req.query.token;
  if (!verifyToken(tok)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Seed demo quiz ────────────────────────────────────────────────────────────
const count = db.prepare('SELECT COUNT(*) as n FROM quizzes').get();
if (count.n === 0) {
  const qid = uuidv4();
  db.prepare(`INSERT INTO quizzes(id,title,desc,cover_emoji) VALUES(?,?,?,?)`)
    .run(qid, 'ITQ AI Event 2026', 'From Idea to Production', '🚀');
  const qs = [
    { text:"What is one of the biggest myths about AI adoption?", a:"Private AI is always more expensive", b:"AI adoption happens automatically once deployed", c:"Open Source always outperforms proprietary", d:"GPU hardware is the main bottleneck", correct:1, time:20 },
    { text:"Johan's key warning about AI infrastructure?", a:"Always overprovision CPUs", b:"Infrastructure size doesn't matter", c:"Size does matter — especially for infra", d:"Edge appliances are always sufficient", correct:2, time:20 },
    { text:"What did Johan say about a PoC?", a:"A PoC is the hardest part", b:"A PoC is a nice trick — but it isn't production", c:"Always build a PoC before buying hardware", d:"A PoC qualifies for production automatically", correct:1, time:20 },
    { text:"Key message about Open Source AI costs?", a:"Always best for enterprise", b:"Has no hidden costs", c:"'Free' — but nothing is actually free", d:"Should replace all commercial platforms", correct:2, time:20 },
    { text:"What problem did Tom's Market Overview app solve?", a:"Automate customer onboarding", b:"Replace manual job-site hunting across 34–35 sources with AI matching", c:"Create a private HR chatbot", d:"Generate sales proposals with an LLM", correct:1, time:20 },
    { text:"How did manual tracking time change after Tom's tool?", a:"10 hrs → 0 hrs/week", b:"8 hrs → 4 hrs/week", c:"5 hrs → 1.5 hrs/week", d:"3 hrs → 30 mins/week", correct:2, time:20 },
    { text:"Tom's AI hardware scaling journey?", a:"Azure → AWS → on-prem", b:"MacBook → Dell GB10 → cloud", c:"Cloud → edge → Raspberry Pi", d:"OpenAI → open source → OpenAI", correct:1, time:20 },
    { text:"What is 'cognitive debt' in the LLM age?", a:"GPU compute costs", b:"Mental overhead of switching AI tools", c:"AI-written code becoming a black box nobody understands", d:"Technical debt from outdated models", correct:2, time:20 },
    { text:"Core accountability message from Day-2 session?", a:"AI vendors are responsible for AI bugs", b:"You can share accountability with the model", c:"If you ship it, you own it — model isn't on the hook", d:"Open source reduces accountability risk", correct:2, time:20 },
    { text:"What should organizations do to avoid Shadow AI chaos?", a:"Block all AI tools until strategy is defined", b:"Adopt AI with standards, policies and data labeling", c:"Let each team pick their own tools", d:"Outsource AI governance to a consultancy", correct:1, time:20 },
    { text:"% of enterprise GenAI pilots with no measurable P&L impact?", a:"45%", b:"65%", c:"80%", d:"95%", correct:3, time:15 },
    { text:"Core engine of the ITQ AI Use Case Factory?", a:"Azure ML with AKS", b:"AWS SageMaker with EKS", c:"Red Hat OpenShift AI", d:"VMware vSphere with NVIDIA AI Enterprise", correct:2, time:15 },
    { text:"ITQ Use Case Factory timeline for Production MVP?", a:"Week 1–4: PoC, Week 5–12: MVP", b:"Week 1–2: PoC, Week 3–6: Production MVP", c:"Month 1: PoC, Month 2–3: MVP", d:"Week 1–8: PoC, Week 9–12: MVP", correct:1, time:15 },
    { text:"What are the 4 layers of the ITQ AI Use Case Factory stack?", a:"App / Platform / Infra / Hardware", b:"Model / API / UI / Database", c:"Dev / Test / Stage / Prod", d:"Prompt / RAG / Agent / Guardrail", correct:0, time:15 },
    { text:"Frontier model release gap in 2026 was approximately how many days? (tiebreaker)", a:"", b:"", c:"", d:"", correct:11, time:30, is_open:1 },
  ];
  const ins = db.prepare(`INSERT INTO questions(id,quiz_id,position,text,option_a,option_b,option_c,option_d,correct,time_limit,is_open) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  qs.forEach((q,i) => ins.run(uuidv4(), qid, i, q.text, q.a||'', q.b||'', q.c||'', q.d||'', q.correct, q.time, q.is_open||0));
  console.log('Seeded demo quiz:', qid);
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // large for logo upload
app.use(express.static(path.join('/app', 'frontend/public')));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/host/login', (req, res) => {
  const { password } = req.body;
  const hash = getSetting('host_password_hash');
  if (bcrypt.compareSync(password, hash)) {
    res.json({ ok: true, token: HOST_TOKEN });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── Settings API ──────────────────────────────────────────────────────────────
app.get('/api/settings', requireHost, (req, res) => {
  const s = getSettings();
  // Never send password hash to client
  delete s.host_password_hash;
  res.json(s);
});

app.put('/api/settings', requireHost, (req, res) => {
  const allowed = ['default_time_limit','leaderboard_every','leaderboard_size','final_leaderboard_size','logo_base64','logo_mime'];
  const tx = db.transaction(() => {
    for (const key of allowed) {
      if (req.body[key] !== undefined) setSetting(key, String(req.body[key]));
    }
  });
  tx();
  res.json({ ok: true });
});

app.put('/api/settings/password', requireHost, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const hash = getSetting('host_password_hash');
  if (!bcrypt.compareSync(currentPassword, hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  const newHash = bcrypt.hashSync(newPassword, 10);
  setSetting('host_password_hash', newHash);
  HOST_TOKEN = makeToken(newHash);
  res.json({ ok: true, token: HOST_TOKEN });
});

// Public endpoint for logo (shown to players too)
app.get('/api/logo', (req, res) => {
  const logo = getSetting('logo_base64');
  const mime = getSetting('logo_mime') || 'image/png';
  if (!logo) return res.status(404).json({ error: 'No logo' });
  const buf = Buffer.from(logo, 'base64');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(buf);
});

// ── Quiz CRUD ─────────────────────────────────────────────────────────────────
app.get('/api/quizzes', requireHost, (req, res) => {
  const quizzes = db.prepare(`SELECT q.*, COUNT(qu.id) as question_count FROM quizzes q LEFT JOIN questions qu ON qu.quiz_id=q.id GROUP BY q.id ORDER BY q.updated_at DESC`).all();
  res.json(quizzes);
});
app.post('/api/quizzes', requireHost, (req, res) => {
  const { title, desc, cover_emoji } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO quizzes(id,title,desc,cover_emoji) VALUES(?,?,?,?)`).run(id, title, desc||'', cover_emoji||'🧠');
  res.json({ ok: true, id });
});
app.get('/api/quizzes/:id', requireHost, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Not found' });
  quiz.questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(req.params.id);
  res.json(quiz);
});
app.put('/api/quizzes/:id', requireHost, (req, res) => {
  const { title, desc, cover_emoji } = req.body;
  db.prepare(`UPDATE quizzes SET title=?,desc=?,cover_emoji=?,updated_at=unixepoch() WHERE id=?`).run(title, desc||'', cover_emoji||'🧠', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/quizzes/:id', requireHost, (req, res) => {
  db.prepare('DELETE FROM quizzes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Question CRUD ─────────────────────────────────────────────────────────────
app.post('/api/quizzes/:qid/questions', requireHost, (req, res) => {
  const { text, option_a, option_b, option_c, option_d, correct, time_limit, points, is_open } = req.body;
  const pos = (db.prepare('SELECT MAX(position) as m FROM questions WHERE quiz_id=?').get(req.params.qid).m ?? -1) + 1;
  const id = uuidv4();
  db.prepare(`INSERT INTO questions(id,quiz_id,position,text,option_a,option_b,option_c,option_d,correct,time_limit,points,is_open) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.params.qid, pos, text, option_a||'', option_b||'', option_c||'', option_d||'', correct??0, time_limit||20, points||1000, is_open?1:0);
  db.prepare(`UPDATE quizzes SET updated_at=unixepoch() WHERE id=?`).run(req.params.qid);
  res.json({ ok: true, id });
});
app.put('/api/questions/:id', requireHost, (req, res) => {
  const { text, option_a, option_b, option_c, option_d, correct, time_limit, points, is_open } = req.body;
  db.prepare(`UPDATE questions SET text=?,option_a=?,option_b=?,option_c=?,option_d=?,correct=?,time_limit=?,points=?,is_open=? WHERE id=?`).run(text, option_a||'', option_b||'', option_c||'', option_d||'', correct??0, time_limit||20, points||1000, is_open?1:0, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/questions/:id', requireHost, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.put('/api/quizzes/:qid/questions/reorder', requireHost, (req, res) => {
  const { order } = req.body;
  const upd = db.prepare('UPDATE questions SET position=? WHERE id=? AND quiz_id=?');
  db.transaction(() => order.forEach((id,i) => upd.run(i, id, req.params.qid)))();
  res.json({ ok: true });
});

// ── Import questions ──────────────────────────────────────────────────────────
// POST /api/quizzes/:id/import  body: { questions: [...], mode: 'append'|'replace' }
app.post('/api/quizzes/:qid/import', requireHost, (req, res) => {
  const { questions, mode } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) return res.status(400).json({ error: 'No questions provided' });

  const tx = db.transaction(() => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM questions WHERE quiz_id=?').run(req.params.qid);
    }
    const startPos = mode === 'replace' ? 0 :
      ((db.prepare('SELECT MAX(position) as m FROM questions WHERE quiz_id=?').get(req.params.qid).m ?? -1) + 1);

    const ins = db.prepare(`INSERT INTO questions(id,quiz_id,position,text,option_a,option_b,option_c,option_d,correct,time_limit,points,is_open) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    questions.forEach((q, i) => {
      ins.run(uuidv4(), req.params.qid, startPos + i,
        q.text || q.question || '',
        q.option_a || q.a || q.options?.[0] || '',
        q.option_b || q.b || q.options?.[1] || '',
        q.option_c || q.c || q.options?.[2] || '',
        q.option_d || q.d || q.options?.[3] || '',
        q.correct ?? q.correct_index ?? 0,
        q.time_limit || q.time || parseInt(getSetting('default_time_limit')) || 20,
        q.points || 1000,
        q.is_open ? 1 : 0
      );
    });
    db.prepare(`UPDATE quizzes SET updated_at=unixepoch() WHERE id=?`).run(req.params.qid);
  });
  tx();
  res.json({ ok: true, imported: questions.length });
});

// ── Export questions ──────────────────────────────────────────────────────────
app.get('/api/quizzes/:id/export', requireHost, (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Not found' });
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(req.params.id);
  res.setHeader('Content-Disposition', `attachment; filename="quizlab-${quiz.title.replace(/\s+/g,'-')}.json"`);
  res.json({
    schema: 'quizlab-v1',
    quiz: { title: quiz.title, desc: quiz.desc, cover_emoji: quiz.cover_emoji },
    questions: questions.map(q => ({
      text: q.text, option_a: q.option_a, option_b: q.option_b,
      option_c: q.option_c, option_d: q.option_d,
      correct: q.correct, time_limit: q.time_limit, points: q.points, is_open: q.is_open
    }))
  });
});

// ── Game management ───────────────────────────────────────────────────────────
function genPin() { return String(Math.floor(100000 + Math.random() * 900000)); }

app.post('/api/games', requireHost, (req, res) => {
  const { quiz_id } = req.body;
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(quiz_id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  if (db.prepare('SELECT COUNT(*) as n FROM questions WHERE quiz_id=?').get(quiz_id).n === 0) return res.status(400).json({ error: 'Quiz has no questions' });
  let pin; do { pin = genPin(); } while (db.prepare("SELECT id FROM games WHERE pin=? AND status!='final'").get(pin));
  const id = uuidv4();
  db.prepare(`INSERT INTO games(id,quiz_id,pin,status) VALUES(?,?,?,?)`).run(id, quiz_id, pin, 'lobby');
  res.json({ ok: true, id, pin });
});
app.get('/api/games/:id', requireHost, (req, res) => {
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!game) return res.status(404).json({ error: 'Not found' });
  game.players = db.prepare('SELECT * FROM players WHERE game_id=? ORDER BY score DESC').all(req.params.id);
  res.json(game);
});
app.get('/api/games/pin/:pin', (req, res) => {
  const game = db.prepare("SELECT id,pin,status FROM games WHERE pin=?").get(req.params.pin);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(game);
});
app.post('/api/games/pin/:pin/join', (req, res) => {
  const game = db.prepare("SELECT * FROM games WHERE pin=?").get(req.params.pin);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.status === 'final') return res.status(400).json({ error: 'Game has ended' });
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  const emailLower = email.toLowerCase().trim();
  const existing = db.prepare('SELECT * FROM players WHERE game_id=? AND email=?').get(game.id, emailLower);
  if (existing) return res.json({ ok: true, playerId: existing.id, name: existing.name, rejoining: true });
  if (game.status !== 'lobby') return res.status(400).json({ error: 'Game already started' });
  const id = uuidv4();
  db.prepare('INSERT INTO players(id,game_id,name,email) VALUES(?,?,?,?)').run(id, game.id, name.trim(), emailLower);
  res.json({ ok: true, playerId: id, gameId: game.id, name: name.trim() });
});

// ── WebSocket game engine ─────────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const rooms  = {};
const gameTimers = {};

function getRoom(gameId) { if (!rooms[gameId]) rooms[gameId] = new Set(); return rooms[gameId]; }
function broadcastToGame(gameId, msg, excludeWs=null) {
  const data = JSON.stringify(msg);
  (rooms[gameId]||new Set()).forEach(c => { if (c.ws!==excludeWs && c.ws.readyState===WebSocket.OPEN) c.ws.send(data); });
}
function sendWs(ws, msg) { if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function getLeaderboard(gameId, limit) {
  const n = limit || parseInt(getSetting('leaderboard_size')) || 10;
  return db.prepare(`SELECT p.id,p.name,p.score FROM players p WHERE p.game_id=? ORDER BY p.score DESC LIMIT ?`).all(gameId, n);
}
function getFinalLeaderboard(gameId) {
  const n = parseInt(getSetting('final_leaderboard_size')) || 5;
  return getLeaderboard(gameId, n);
}

function safeQ(q, idx, total) {
  return { id:q.id, index:idx, total, text:q.text, timeLimit:q.time_limit, points:q.points, isOpen:q.is_open===1, options:q.is_open?null:[q.option_a,q.option_b,q.option_c,q.option_d] };
}

function startQuestion(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!game || game.status==='final') return;
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(game.quiz_id);
  const nextIdx = game.cur_q_idx + 1;
  if (nextIdx >= questions.length) { endQuiz(gameId); return; }
  db.prepare("UPDATE games SET status='question',cur_q_idx=? WHERE id=?").run(nextIdx, gameId);
  const q = questions[nextIdx];
  const startTs = Date.now();
  broadcastToGame(gameId, { type:'question', question:safeQ(q,nextIdx,questions.length), startTime:startTs });
  clearTimeout(gameTimers[gameId]);
  gameTimers[gameId] = setTimeout(() => revealQuestion(gameId), (q.time_limit+2)*1000);
}

function revealQuestion(gameId) {
  clearTimeout(gameTimers[gameId]);
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!game) return;
  const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(game.quiz_id);
  const q = questions[game.cur_q_idx];
  if (!q) return;
  db.prepare("UPDATE games SET status='reveal' WHERE id=?").run(gameId);
  broadcastToGame(gameId, {
    type:'reveal', questionId:q.id,
    correctIndex: q.is_open ? null : q.correct,
    correctAnswer: q.is_open ? q.correct : [q.option_a,q.option_b,q.option_c,q.option_d][q.correct],
    leaderboard: getLeaderboard(gameId, 5),
    answerCount: db.prepare('SELECT COUNT(*) as n FROM answers WHERE game_id=? AND question_id=?').get(gameId,q.id).n,
    playerCount: db.prepare('SELECT COUNT(*) as n FROM players WHERE game_id=?').get(gameId).n,
  });
  gameTimers[gameId] = setTimeout(() => {
    const qNum = game.cur_q_idx + 1;
    const every = parseInt(getSetting('leaderboard_every')) || 5;
    const totalQ = questions.length;
    if (every > 0 && qNum % every === 0 && qNum < totalQ) {
      showLeaderboard(gameId);
    } else {
      startQuestion(gameId);
    }
  }, 5000);
}

function showLeaderboard(gameId) {
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
  if (!game) return;
  const totalQ = db.prepare('SELECT COUNT(*) as n FROM questions WHERE quiz_id=?').get(game.quiz_id).n;
  db.prepare("UPDATE games SET status='leaderboard' WHERE id=?").run(gameId);
  broadcastToGame(gameId, { type:'leaderboard', leaderboard:getLeaderboard(gameId), questionsDone:game.cur_q_idx+1, totalQ });
  gameTimers[gameId] = setTimeout(() => startQuestion(gameId), 8000);
}

function endQuiz(gameId) {
  db.prepare("UPDATE games SET status='final',ended_at=unixepoch() WHERE id=?").run(gameId);
  broadcastToGame(gameId, { type:'final', leaderboard:getFinalLeaderboard(gameId) });
}

app.post('/api/games/:id/start', requireHost, (req,res) => {
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!game||game.status!=='lobby') return res.status(400).json({ error:'Cannot start' });
  startQuestion(req.params.id); res.json({ ok:true });
});
app.post('/api/games/:id/next', requireHost, (req,res) => {
  const game = db.prepare('SELECT * FROM games WHERE id=?').get(req.params.id);
  if (!game) return res.status(404).json({ error:'Not found' });
  clearTimeout(gameTimers[game.id]);
  if (game.status==='question') revealQuestion(game.id);
  else if (game.status==='reveal'||game.status==='leaderboard') startQuestion(game.id);
  res.json({ ok:true });
});
app.post('/api/games/:id/end', requireHost, (req,res) => {
  endQuiz(req.params.id);
  res.json({ ok:true });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let ctx = { gameId:null, playerId:null, isHost:false };

  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    if (msg.type==='host_join') {
      if (!verifyToken(msg.token)) { sendWs(ws,{type:'error',msg:'Bad token'}); return; }
      const game = db.prepare('SELECT * FROM games WHERE id=?').get(msg.gameId);
      if (!game) { sendWs(ws,{type:'error',msg:'Game not found'}); return; }
      ctx = { gameId:game.id, playerId:null, isHost:true };
      getRoom(game.id).add({ws,...ctx});
      const players = db.prepare('SELECT * FROM players WHERE game_id=? ORDER BY score DESC').all(game.id);
      sendWs(ws,{type:'host_joined',game,players,playerCount:players.length});
      return;
    }

    if (msg.type==='player_join') {
      const player = db.prepare('SELECT * FROM players WHERE id=?').get(msg.playerId);
      if (!player) { sendWs(ws,{type:'error',msg:'Unknown player'}); return; }
      const game = db.prepare('SELECT * FROM games WHERE id=?').get(player.game_id);
      ctx = { gameId:game.id, playerId:player.id, isHost:false };
      getRoom(game.id).add({ws,...ctx});
      const playerCount = db.prepare('SELECT COUNT(*) as n FROM players WHERE game_id=?').get(game.id).n;
      broadcastToGame(game.id,{type:'player_joined',playerCount,name:player.name},ws);
      sendWs(ws,{type:'player_joined_ack',name:player.name,score:player.score,phase:game.status,playerCount});
      if (game.status==='question') {
        const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(game.quiz_id);
        const q = questions[game.cur_q_idx];
        if (q) sendWs(ws,{type:'question',question:safeQ(q,game.cur_q_idx,questions.length),startTime:null});
      }
      return;
    }

    if (msg.type==='answer') {
      if (!ctx.playerId) return;
      const game = db.prepare("SELECT * FROM games WHERE id=?").get(ctx.gameId);
      if (!game||game.status!=='question') return;
      const questions = db.prepare('SELECT * FROM questions WHERE quiz_id=? ORDER BY position').all(game.quiz_id);
      const q = questions[game.cur_q_idx];
      if (!q) return;
      if (db.prepare('SELECT id FROM answers WHERE game_id=? AND question_id=? AND player_id=?').get(ctx.gameId,q.id,ctx.playerId)) return;
      const elapsedMs = msg.elapsedMs||0;
      let isCorrect = false;
      if (q.is_open) { const p=parseInt(msg.value,10); isCorrect=!isNaN(p)&&Math.abs(p-q.correct)<=1; }
      else { isCorrect = msg.answerIndex===q.correct; }
      let pts = 0;
      if (isCorrect) { const sr=Math.max(0,1-elapsedMs/(q.time_limit*1000)); pts=q.points+Math.round(500*sr); }
      db.prepare(`INSERT INTO answers(id,game_id,question_id,player_id,answer_idx,answer_text,is_correct,points,elapsed_ms) VALUES(?,?,?,?,?,?,?,?,?)`).run(uuidv4(),ctx.gameId,q.id,ctx.playerId,msg.answerIndex??null,msg.value??null,isCorrect?1:0,pts,elapsedMs);
      db.prepare('UPDATE players SET score=score+? WHERE id=?').run(pts,ctx.playerId);
      const newScore = db.prepare('SELECT score FROM players WHERE id=?').get(ctx.playerId).score;
      sendWs(ws,{type:'answer_ack',isCorrect,points:pts,totalScore:newScore});
      const ansCount = db.prepare('SELECT COUNT(*) as n FROM answers WHERE game_id=? AND question_id=?').get(ctx.gameId,q.id).n;
      const plCount  = db.prepare('SELECT COUNT(*) as n FROM players WHERE game_id=?').get(ctx.gameId).n;
      broadcastToGame(ctx.gameId,{type:'answer_count',count:ansCount,total:plCount});
      if (ansCount>=plCount) { clearTimeout(gameTimers[ctx.gameId]); setTimeout(()=>revealQuestion(ctx.gameId),500); }
      return;
    }
  });

  ws.on('close', () => {
    if (ctx.gameId) { const room=rooms[ctx.gameId]; if(room) room.forEach(c=>{if(c.ws===ws)room.delete(c);}); }
  });
});

// ── Fallback SPA ──────────────────────────────────────────────────────────────
app.get('*', (req,res) => res.sendFile(path.join('/app','frontend/public/index.html')));

server.listen(PORT, () => console.log(`QuizLab running on :${PORT}`));
