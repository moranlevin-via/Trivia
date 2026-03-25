const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

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

app.get('/api/quizzes', (req, res) => res.json(loadQuizzes()));

app.get('/api/quizzes/:id', (req, res) => {
  const quiz = loadQuizzes().find(q => q.id === req.params.id);
  quiz ? res.json(quiz) : res.status(404).json({ error: 'Not found' });
});

app.post('/api/quizzes', (req, res) => {
  const quizzes = loadQuizzes();
  const quiz = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() };
  quizzes.push(quiz);
  saveQuizzes(quizzes);
  res.json(quiz);
});

app.put('/api/quizzes/:id', (req, res) => {
  const quizzes = loadQuizzes();
  const idx = quizzes.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  quizzes[idx] = { ...quizzes[idx], ...req.body, id: req.params.id };
  saveQuizzes(quizzes);
  res.json(quizzes[idx]);
});

app.delete('/api/quizzes/:id', (req, res) => {
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
    const speedBonus = isCorrect ? Math.round(Math.max(0, timeLeft) * 10) : 0;
    const points = isCorrect ? (1000 + speedBonus) : 0;

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
