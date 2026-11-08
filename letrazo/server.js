const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

/* ---------- Diccionario ---------- */
// Quita tildes pero conserva la Ñ. Todo en mayúsculas.
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/ñ/g, '\u0001')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0001/g, 'ñ')
    .toUpperCase();

let DICT = new Set();
let LENIENT = true; // sin diccionario: se acepta cualquier camino válido

function loadDict() {
  let list = [];
  try {
    const p = path.join(__dirname, 'words.txt');
    if (fs.existsSync(p)) list = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  } catch (_) {}
  if (list.length < 5000) {
    try { list = require('an-array-of-spanish-words'); } catch (_) {}
  }
  const set = new Set();
  for (const w of list) {
    const n = norm(String(w).trim());
    if (/^[A-ZÑ]{3,16}$/.test(n)) set.add(n);
  }
  DICT = set;
  LENIENT = set.size < 5000;
  console.log(LENIENT
    ? 'Diccionario NO cargado: modo permisivo (acepta cualquier palabra que esté en el tablero).'
    : `Diccionario cargado: ${set.size} palabras.`);
}
loadDict();

/* ---------- Tablero ---------- */
const FREQ = { A:12, E:13, O:9, S:8, R:7, N:7, I:6, D:5, L:5, C:5, T:4, U:4, M:3, P:3, B:2, H:1, Y:1, V:1, G:1, F:1, J:1, Z:1, Ñ:1, X:1 };
const BAG = [];
for (const [l, n] of Object.entries(FREQ)) for (let i = 0; i < n; i++) BAG.push(l);

function makeGrid() {
  for (;;) {
    const g = Array.from({ length: 16 }, () => BAG[Math.floor(Math.random() * BAG.length)]);
    const v = g.filter((l) => 'AEIOU'.includes(l)).length;
    if (v >= 5 && v <= 8) return g;
  }
}

function hasPath(grid, word) {
  const used = Array(16).fill(false);
  const dfs = (i, k) => {
    if (grid[i] !== word[k]) return false;
    if (k === word.length - 1) return true;
    used[i] = true;
    const r = (i / 4) | 0, c = i % 4;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr > 3 || nc < 0 || nc > 3) continue;
        const j = nr * 4 + nc;
        if (!used[j] && dfs(j, k + 1)) { used[i] = false; return true; }
      }
    }
    used[i] = false;
    return false;
  };
  for (let i = 0; i < 16; i++) if (dfs(i, 0)) return true;
  return false;
}

const points = (len) => (len <= 4 ? 1 : len === 5 ? 2 : len === 6 ? 3 : len === 7 ? 5 : 11);

/* ---------- Salas ---------- */
const ROUNDS = 3;
const DURATION = 90; // segundos
const rooms = new Map();

function makeCode() {
  const c = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
    if (!rooms.has(s)) return s;
  }
}

function newRoom() {
  const room = {
    code: makeCode(), players: new Map(), hostId: null, phase: 'lobby',
    grid: [], endsAt: 0, round: 0, timer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function publicState(room) {
  return {
    code: room.code, phase: room.phase, hostId: room.hostId,
    round: room.round, totalRounds: ROUNDS, duration: DURATION,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, total: p.total, count: p.words.size,
    })),
  };
}
const broadcast = (room) => io.to(room.code).emit('room:update', publicState(room));

function startRound(room) {
  room.round += 1;
  room.phase = 'playing';
  room.grid = makeGrid();
  room.endsAt = Date.now() + DURATION * 1000;
  for (const p of room.players.values()) p.words = new Map();
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), DURATION * 1000 + 300);
  broadcast(room);
  io.to(room.code).emit('round:start', { grid: room.grid, remaining: DURATION * 1000, round: room.round });
}

function endRound(room) {
  if (room.phase !== 'playing') return;
  clearTimeout(room.timer);
  room.phase = 'results';
  const seen = new Map(); // palabra -> cuántos jugadores la tienen
  for (const p of room.players.values()) for (const w of p.words.keys()) seen.set(w, (seen.get(w) || 0) + 1);
  const results = [];
  for (const p of room.players.values()) {
    let roundScore = 0;
    const words = [...p.words.keys()].map((w) => {
      const shared = seen.get(w) > 1;
      const pts = points(w.length);
      if (!shared) roundScore += pts;
      return { w, pts, shared };
    }).sort((a, b) => b.w.length - a.w.length || a.w.localeCompare(b.w));
    p.total += roundScore;
    results.push({ id: p.id, name: p.name, roundScore, total: p.total, words });
  }
  results.sort((a, b) => b.total - a.total);
  io.to(room.code).emit('round:end', { round: room.round, totalRounds: ROUNDS, results, final: room.round >= ROUNDS });
  broadcast(room);
}

io.on('connection', (socket) => {
  socket.on('join', ({ name, code } = {}, ack = () => {}) => {
    name = String(name || '').trim().slice(0, 14) || 'Jugador';
    let room;
    if (code && String(code).trim()) {
      room = rooms.get(String(code).trim().toUpperCase());
      if (!room) return ack({ ok: false, error: 'Esa sala no existe. Revisa el código.' });
      if (room.players.size >= 12) return ack({ ok: false, error: 'La sala está llena (12 jugadores).' });
    } else {
      room = newRoom();
    }
    room.players.set(socket.id, { id: socket.id, name, total: 0, words: new Map() });
    if (!room.hostId) room.hostId = socket.id;
    socket.join(room.code);
    socket.data.code = room.code;
    ack({ ok: true, code: room.code, id: socket.id });
    broadcast(room);
    if (room.phase === 'playing') {
      socket.emit('round:start', { grid: room.grid, remaining: Math.max(0, room.endsAt - Date.now()), round: room.round });
    }
  });

  socket.on('start', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase === 'lobby') startRound(room);
  });

  socket.on('next', () => {
    const room = rooms.get(socket.data.code);
    if (!room || room.hostId !== socket.id || room.phase !== 'results') return;
    if (room.round < ROUNDS) return startRound(room);
    room.round = 0;
    room.phase = 'lobby';
    for (const p of room.players.values()) { p.total = 0; p.words = new Map(); }
    broadcast(room);
  });

  socket.on('word', ({ word } = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.code);
    const p = room && room.players.get(socket.id);
    if (!p || room.phase !== 'playing' || Date.now() > room.endsAt + 300) return ack({ ok: false, error: 'La ronda ya terminó.' });
    const w = norm(word || '');
    if (!/^[A-ZÑ]+$/.test(w) || w.length < 3) return ack({ ok: false, error: 'Mínimo 3 letras.' });
    if (p.words.has(w)) return ack({ ok: false, error: 'Ya la tenías.' });
    if (!hasPath(room.grid, w)) return ack({ ok: false, error: 'No se puede formar en el tablero.' });
    if (!LENIENT && !DICT.has(w)) return ack({ ok: false, error: 'No está en el diccionario.' });
    p.words.set(w, true);
    ack({ ok: true, word: w, pts: points(w.length) });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) { clearTimeout(room.timer); rooms.delete(room.code); return; }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Letrazo escuchando en el puerto ${PORT}`));
