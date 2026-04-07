const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// ── Admin auth ────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Viavia2020!';
const ADMIN_TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const adminTokens = new Map(); // token -> expiresAt

function createAdminToken() {
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}

function isValidAdminToken(token) {
  if (!token) return false;
  const expiresAt = adminTokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of adminTokens.entries()) {
    if (expiresAt < now) adminTokens.delete(token);
  }
}, 1000 * 60 * 10);

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: createAdminToken() });
});

app.get('/api/admin/verify', (req, res) => {
  const token = req.header('x-admin-token');
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.header('x-admin-token');
  adminTokens.delete(token);
  res.json({ ok: true });
});

// ── File uploads ──────────────────────────────────────────────────────────────

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm'];
    cb(null, allowed.includes(file.mimetype));
  },
});

app.use('/uploads', express.static(UPLOADS_DIR));

app.post('/api/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  let mediaType = 'image';
  if (req.file.mimetype.startsWith('video')) mediaType = 'video';
  else if (req.file.mimetype.startsWith('audio')) mediaType = 'audio';
  res.json({ url: `/uploads/${req.file.filename}`, mediaType });
});

// ── Quiz storage ──────────────────────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, 'data', 'quizzes.json');

let quizzesCache = null;

function loadQuizzes() {
  if (quizzesCache) return quizzesCache;
  if (!fs.existsSync(DATA_FILE)) return (quizzesCache = []);
  try { return (quizzesCache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
  catch { return (quizzesCache = []); }
}

function saveQuizzes(quizzes) {
  quizzesCache = quizzes;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(quizzes, null, 2));
}

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/quizzes', requireAdmin, (req, res) => res.json(loadQuizzes()));

app.get('/api/quizzes/:id', requireAdmin, (req, res) => {
  const quiz = loadQuizzes().find(q => q.id === req.params.id);
  quiz ? res.json(quiz) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/quizzes', requireAdmin, (req, res) => {
  const quizzes = loadQuizzes();
  const quiz = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() };
  quizzes.push(quiz);
  saveQuizzes(quizzes);
  res.json(quiz);
});

app.put('/api/quizzes/:id', requireAdmin, (req, res) => {
  const quizzes = loadQuizzes();
  const idx = quizzes.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  quizzes[idx] = { ...quizzes[idx], ...req.body, id: req.params.id };
  saveQuizzes(quizzes);
  res.json(quizzes[idx]);
});

app.delete('/api/quizzes/:id', requireAdmin, (req, res) => {
  const quizzes = loadQuizzes().filter(q => q.id !== req.params.id);
  saveQuizzes(quizzes);
  res.json({ ok: true });
});

// ── Game state ────────────────────────────────────────────────────────────────

const games = {}; // code -> game

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function getLeaderboard(game, limit = 5) {
  return Object.values(game.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function sendQuestion(code) {
  const game = games[code];
  if (!game) return;

  const qIdx = game.currentQuestion;
  const q = game.quiz.questions[qIdx];
  game.answers[qIdx] = {};

  const payload = {
    index: qIdx,
    total: game.quiz.questions.length,
    question: q.question,
    options: q.options,
    timeLimit: q.timeLimit || 20,
    mediaUrl: q.mediaUrl || null,
    mediaType: q.mediaType || null,
    dir: q.dir || 'rtl',
  };

  io.to(code).emit('question', payload);

  clearTimeout(game.timer);
  game.timer = setTimeout(() => endQuestion(code), (q.timeLimit || 20) * 1000 + 500);
}

function endQuestion(code) {
  const game = games[code];
  if (!game || game.questionEnded) return;
  game.questionEnded = true;
  clearTimeout(game.timer);

  const qIdx = game.currentQuestion;
  const q = game.quiz.questions[qIdx];
  const answers = game.answers[qIdx] || {};

  const answerCounts = q.options.map((_, i) =>
    Object.values(answers).filter(a => a.answerIndex === i).length
  );

  io.to(code).emit('question-ended', {
    correctAnswer: q.correctAnswer,
    answerCounts,
    leaderboard: getLeaderboard(game),
  });
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // HOST: create a game room
  socket.on('create-game', ({ quizId }) => {
    const quiz = loadQuizzes().find(q => q.id === quizId);
    if (!quiz) return socket.emit('error', 'Quiz not found');

    let code;
    do { code = generateCode(); } while (games[code]);

    games[code] = {
      code,
      quiz,
      hostId: socket.id,
      players: {},
      status: 'lobby',
      currentQuestion: -1,
      answers: {},
      timer: null,
      questionEnded: false,
    };

    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'host';
    socket.emit('game-created', { code, quiz });
  });

  // PLAYER: join a game
  socket.on('join-game', ({ code, name }) => {
    const game = games[code];
    if (!game) return socket.emit('join-error', 'Game not found');
    if (game.status !== 'lobby') return socket.emit('join-error', 'Game already started');

    const trimmed = (name || '').trim().slice(0, 20);
    if (!trimmed) return socket.emit('join-error', 'Name required');

    game.players[socket.id] = { id: socket.id, name: trimmed, score: 0 };
    socket.join(code);
    socket.data.code = code;
    socket.data.role = 'player';

    const players = Object.values(game.players);
    io.to(code).emit('players-updated', players);
    socket.emit('joined-game', { code, quizTitle: game.quiz.title });
  });

  // HOST: start game
  socket.on('start-game', ({ code }) => {
    const game = games[code];
    if (!game || game.hostId !== socket.id) return;
    if (Object.keys(game.players).length === 0) return socket.emit('error', 'No players yet');

    game.status = 'playing';
    game.currentQuestion = 0;
    game.questionEnded = false;
    io.to(code).emit('game-started');
    sendQuestion(code);
  });

  // HOST: manually end a question early
  socket.on('end-question', ({ code }) => {
    const game = games[code];
    if (!game || game.hostId !== socket.id) return;
    clearTimeout(game.timer);
    endQuestion(code);
  });

  // HOST: go to next question
  socket.on('next-question', ({ code }) => {
    const game = games[code];
    if (!game || game.hostId !== socket.id) return;

    game.currentQuestion++;
    game.questionEnded = false;

    if (game.currentQuestion >= game.quiz.questions.length) {
      game.status = 'ended';
      io.to(code).emit('game-ended', {
        leaderboard: Object.values(game.players).sort((a, b) => b.score - a.score),
      });
    } else {
      sendQuestion(code);
    }
  });

  // PLAYER: submit answer
  socket.on('submit-answer', ({ code, answerIndex, timeLeft }) => {
    const game = games[code];
    if (!game || game.status !== 'playing') return;

    const qIdx = game.currentQuestion;
    if (!game.answers[qIdx]) game.answers[qIdx] = {};
    if (game.answers[qIdx][socket.id] !== undefined) return; // already answered

    const q = game.quiz.questions[qIdx];
    const isCorrect = answerIndex === q.correctAnswer;
    const maxT = q.timeLimit || 20;
    let t = Math.max(0, Number(timeLeft));
    if (!Number.isFinite(t)) t = 0;
    t = Math.min(t, maxT);
    // 50 pts per full second + 5 pts per tenth of a second remaining (same as floor(t*10)*5)
    const speedBonus = isCorrect ? Math.floor(t * 10) * 5 : 0;
    const points = isCorrect ? (500 + speedBonus) : 0;

    game.answers[qIdx][socket.id] = { answerIndex, isCorrect, points };
    if (game.players[socket.id]) game.players[socket.id].score += points;

    socket.emit('answer-result', { isCorrect, points });

    const answerCount = Object.keys(game.answers[qIdx]).length;
    const playerCount = Object.keys(game.players).length;
    io.to(game.hostId).emit('answer-count', { count: answerCount, total: playerCount });

    if (answerCount >= playerCount) {
      clearTimeout(game.timer);
      endQuestion(code);
    }
  });

  // HOST: kick a player
  socket.on('kick-player', ({ code, playerId }) => {
    const game = games[code];
    if (!game || game.hostId !== socket.id) return;
    delete game.players[playerId];
    io.to(playerId).emit('kicked');
    io.to(code).emit('players-updated', Object.values(game.players));
  });

  socket.on('disconnect', () => {
    const { code, role } = socket.data;
    if (!code || !games[code]) return;
    const game = games[code];

    if (role === 'host') {
      io.to(code).emit('host-disconnected');
      clearTimeout(game.timer);
      delete games[code];
    } else {
      delete game.players[socket.id];
      io.to(code).emit('players-updated', Object.values(game.players));
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Quiz platform running at http://localhost:${PORT}`);
});
