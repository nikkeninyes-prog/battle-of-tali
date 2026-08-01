const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_PATH = path.join(__dirname, 'data', 'cards.json');
const DECKS_PATH = path.join(__dirname, 'data', 'decks.json');
const ACCOUNTS_PATH = path.join(__dirname, 'data', 'accounts.json');
if (!fs.existsSync(DECKS_PATH)) fs.writeFileSync(DECKS_PATH, '[]');
if (!fs.existsSync(ACCOUNTS_PATH)) fs.writeFileSync(ACCOUNTS_PATH, '[]');

app.use(express.json({ limit: '15mb' })); // raised so base64 card images can be saved via /api/cards

// ---------- Accounts / login ----------
// Change this via the SESSION_SECRET environment variable on Render (Environment tab) —
// anyone who knows this secret could forge login tokens, so treat it like a password.
const SESSION_SECRET = process.env.SESSION_SECRET || 'talingchan-dev-secret-change-me';
const STARTING_COINS = 300; // "ตลิ่งคอยน์" starting balance — placeholder until a real earn/purchase flow exists

function loadAccounts() { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); }
function saveAccounts(accs) { fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accs, null, 2)); }
function findAccount(username) { return loadAccounts().find(a => a.username.toLowerCase() === (username || '').toLowerCase()); }
function makeToken(username) { return jwt.sign({ username }, SESSION_SECRET, { expiresIn: '90d' }); }
function publicAccount(a) { return { username: a.username, coins: a.coins }; }

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'ต้องเข้าสู่ระบบก่อน' });
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    const account = findAccount(payload.username);
    if (!account) return res.status(401).json({ error: 'ไม่พบบัญชีนี้แล้ว' });
    req.account = account;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !/^[a-zA-Z0-9_ก-๙]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'ชื่อผู้ใช้ต้อง 3-20 ตัวอักษร (a-z, 0-9, _, ไทย)' });
  }
  if (!password || password.length < 4) return res.status(400).json({ error: 'รหัสผ่านอย่างน้อย 4 ตัวอักษร' });
  const accounts = loadAccounts();
  if (accounts.find(a => a.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'มีชื่อผู้ใช้นี้แล้ว' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const account = { username, passwordHash, coins: STARTING_COINS, createdAt: Date.now() };
  accounts.push(account);
  saveAccounts(accounts);
  res.json({ ok: true, token: makeToken(username), ...publicAccount(account) });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const account = findAccount(username);
  if (!account) return res.status(401).json({ error: 'ไม่พบผู้ใช้นี้' });
  const match = await bcrypt.compare(password || '', account.passwordHash);
  if (!match) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
  res.json({ ok: true, token: makeToken(account.username), ...publicAccount(account) });
});

app.get('/api/me', requireAuth, (req, res) => res.json(publicAccount(req.account)));

// Manual coin top-up until a real earn/purchase flow (ads, payment, gacha shop) exists.
// Protected by the same admin password as /admin.html.
app.post('/api/admin/grant-coins', requireAdminAuth, (req, res) => {
  const { username, amount } = req.body || {};
  if (!username || !Number.isInteger(amount)) return res.status(400).json({ error: 'username, amount(int) required' });
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
  if (!acc) return res.status(404).json({ error: 'ไม่พบผู้ใช้นี้' });
  acc.coins = Math.max(0, acc.coins + amount);
  saveAccounts(accounts);
  res.json({ ok: true, username: acc.username, coins: acc.coins });
});
app.get('/api/admin/accounts', requireAdminAuth, (req, res) => res.json(loadAccounts().map(publicAccount)));

// ---------- Admin password gate ----------
// Change this via the ADMIN_PASSWORD environment variable on Render (Environment tab).
// Username is always "admin". Default password below is only for local testing.
const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'talingchan2026';

function requireAdminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Battle of Talingchan Admin"');
  return res.status(401).send('ต้องใส่รหัสผ่านก่อนเข้าหน้า Admin');
}

// must be registered BEFORE express.static so it actually gates the file
app.use('/admin.html', requireAdminAuth);
app.use('/api/cards', requireAdminAuth);
app.use('/api/upload-image', requireAdminAuth);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Card data helpers ----------
function loadCards() { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
function saveCards(cards) { fs.writeFileSync(DATA_PATH, JSON.stringify(cards, null, 2)); }

// ---------- Admin API (password-protected above) ----------
// Images are stored as base64 data URIs directly inside cards.json — no disk
// uploads folder needed, so nothing is lost when Render redeploys/restarts
// (Render's filesystem is not persistent between deploys on the free tier).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

app.get('/api/cards', (req, res) => res.json(loadCards()));
app.post('/api/cards', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'expected array' });
  saveCards(req.body);
  res.json({ ok: true });
});
app.post('/api/upload-image', upload.single('image'), (req, res) => {
  const { cardId } = req.body;
  if (!cardId || !req.file) return res.status(400).json({ error: 'cardId and image required' });
  const cards = loadCards();
  const card = cards.find(c => c.id === cardId);
  if (!card) return res.status(404).json({ error: 'card not found' });
  const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  card.image = dataUri;
  saveCards(cards);
  res.json({ ok: true, image: dataUri });
});

// ---------- Deck builder ----------
// Decks are keyed by the logged-in account's username now that accounts exist.
const DECK_SIZE = 50;
const MAX_COPIES = 4;

app.get('/api/cards-public', (req, res) => res.json(loadCards())); // no auth — anyone can browse the card pool to build a deck

function loadDecks() { return JSON.parse(fs.readFileSync(DECKS_PATH, 'utf8')); }
function saveDecks(decks) { fs.writeFileSync(DECKS_PATH, JSON.stringify(decks, null, 2)); }
function normName(s) { return (s || '').trim().toLowerCase(); }

app.get('/api/decks', requireAuth, (req, res) => {
  res.json(loadDecks().filter(d => normName(d.player) === normName(req.account.username)));
});

app.post('/api/decks', requireAuth, (req, res) => {
  const player = req.account.username;
  const { deckName, cards } = req.body || {};
  if (!deckName || !Array.isArray(cards)) return res.status(400).json({ error: 'deckName, cards required' });
  const allCards = loadCards();
  let total = 0;
  for (const entry of cards) {
    const def = allCards.find(c => c.id === entry.id);
    if (!def) return res.status(400).json({ error: `การ์ด ${entry.id} ไม่มีอยู่จริง` });
    if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > MAX_COPIES) {
      return res.status(400).json({ error: `${def.name} ใส่ได้ 1-${MAX_COPIES} ใบ` });
    }
    total += entry.count;
  }
  if (total !== DECK_SIZE) return res.status(400).json({ error: `เด็คต้องมี ${DECK_SIZE} ใบพอดี (ตอนนี้ ${total})` });

  const decks = loadDecks();
  const idx = decks.findIndex(d => normName(d.player) === normName(player) && d.deckName === deckName);
  const record = { player, deckName, cards, updatedAt: Date.now() };
  if (idx >= 0) decks[idx] = record; else decks.push(record);
  saveDecks(decks);
  res.json({ ok: true });
});

app.delete('/api/decks', requireAuth, (req, res) => {
  const { deckName } = req.body || {};
  if (!deckName) return res.status(400).json({ error: 'deckName required' });
  const decks = loadDecks().filter(d => !(normName(d.player) === normName(req.account.username) && d.deckName === deckName));
  saveDecks(decks);
  res.json({ ok: true });
});

const START_LIFE = 5;
const MAX_FIELD = 4;

const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function buildDeck() {
  const base = loadCards();
  let deck = [];
  base.forEach(c => {
    const copies = c.type === 'avatar' ? 3 : 2;
    for (let i = 0; i < copies; i++) deck.push({ ...c, uid: null });
  });
  return shuffle(deck);
}

// Builds a 50-card deck from a chosen deck spec [{id,count}]. Returns null if invalid
// (caller falls back to a random buildDeck() so a bad/missing deck never blocks play).
function buildDeckFromSpec(spec) {
  if (!Array.isArray(spec) || !spec.length) return null;
  const base = loadCards();
  let deck = [];
  let total = 0;
  for (const entry of spec) {
    const def = base.find(c => c.id === entry.id);
    if (!def || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > MAX_COPIES) return null;
    total += entry.count;
    for (let i = 0; i < entry.count; i++) deck.push({ ...def, uid: null });
  }
  if (total !== DECK_SIZE) return null;
  return shuffle(deck);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

let uidCounter = 1;
function nextUid() { return 'u' + (uidCounter++); }

function newPlayer(socketId, name, deckSpec) {
  return {
    socketId, name,
    deck: buildDeckFromSpec(deckSpec) || buildDeck(),
    hand: [],
    field: [],
    graveyard: [],
    life: START_LIFE,
    critical: false,
    lost: false,
    playedAvatar: false,
    playedMagic: false,
    counterPending: null
  };
}

function drawCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    if (player.deck.length === 0) {
      player.lost = true;
      addLog(room, `${player.name} จั่วการ์ดไม่ได้ (เด็คหมด) — แพ้!`);
      checkWin(room);
      return;
    }
    player.hand.push(player.deck.pop());
  }
}

function publicState(room, forSocketId) {
  const players = room.players.map((p, idx) => ({
    idx, name: p.name, life: p.life, critical: p.critical,
    deckCount: p.deck.length, handCount: p.hand.length,
    hand: p.socketId === forSocketId ? p.hand : [],
    field: p.field, graveyard: p.graveyard,
    playedAvatar: p.playedAvatar, playedMagic: p.playedMagic,
    hasCounter: !!p.counterPending,
    counterName: p.counterPending ? p.counterPending.name : null
  }));
  return {
    code: room.code, started: room.started, turn: room.turn, phase: room.phase,
    firstTurn: room.firstTurn, winner: room.winner !== undefined ? room.winner : null,
    landZone: room.landZone || null,
    log: room.log.slice(-30), players,
    you: room.players.findIndex(p => p.socketId === forSocketId)
  };
}

function broadcast(room) { room.players.forEach(p => { if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.socketId)); }); }
function addLog(room, msg) { room.log.push(msg); if (room.log.length > 100) room.log.shift(); }

function checkWin(room) {
  if (room.winner !== undefined) return;
  room.players.forEach((p, idx) => {
    if (p.lost || p.life < 0) {
      room.winner = 1 - idx;
      addLog(room, `${room.players[1 - idx].name} ชนะ!`);
    }
  });
}

function dealLifeDamage(room, defender, hits) {
  for (let i = 0; i < hits; i++) {
    if (defender.life > 0) {
      defender.life -= 1;
      if (defender.life === 0) { defender.critical = true; addLog(room, `${defender.name} เข้าสู่สถานะ "สาหัส"! โดนอีกครั้งเดียวแพ้`); }
    } else if (defender.critical) {
      defender.life = -1;
    }
  }
}

function applyMagic(room, casterIdx, targetUid, card) {
  const caster = room.players[casterIdx];
  const opponent = room.players[1 - casterIdx];
  const eff = card.effect || {};
  switch (eff.kind) {
    case 'field_buff': {
      [caster, opponent].forEach(pl => pl.field.forEach(f => { f.power = Math.max(0, f.power + eff.value); }));
      addLog(room, `${caster.name} ใช้ ${card.name}: Power ทุกตัวในสนาม ${eff.value >= 0 ? '+' : ''}${eff.value}`);
      break;
    }
    case 'buff_power': {
      const target = caster.field.find(f => f.uid === targetUid);
      if (target) {
        target.power += eff.value;
        if (!target.attachments) target.attachments = [];
        target.attachments.push(card.name);
        addLog(room, `${caster.name} ใช้ ${card.name} กับ ${target.name}: Power +${eff.value}`);
      }
      break;
    }
    case 'damage': {
      const target = opponent.field.find(f => f.uid === targetUid);
      if (target) {
        target.power -= eff.value;
        addLog(room, `${caster.name} ใช้ ${card.name} ใส่ ${target.name}: Power -${eff.value}`);
        if (target.power <= 0) {
          opponent.field = opponent.field.filter(f => f.uid !== targetUid);
          opponent.graveyard.push(target);
          addLog(room, `${target.name} ถูกทำลาย`);
        }
      }
      break;
    }
    case 'heal_life': {
      caster.life = Math.min(START_LIFE, caster.life + eff.value);
      if (caster.life > 0) caster.critical = false;
      addLog(room, `${caster.name} ใช้ ${card.name}: ฟื้น Life Card +${eff.value}`);
      break;
    }
    default:
      addLog(room, `${caster.name} ใช้ ${card.name}`);
  }
  caster.graveyard.push(card);
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (!findAccount(payload.username)) return next(new Error('unauthorized'));
    socket.data.username = payload.username;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.on('createRoom', ({ deck }) => {
    const code = makeRoomCode();
    const room = { code, players: [newPlayer(socket.id, socket.data.username, deck)], started: false, turn: 0, phase: 'main', firstTurn: true, log: [], winner: undefined };
    rooms[code] = room;
    socket.join(code);
    socket.data.room = code;
    io.to(socket.id).emit('joined', { code });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, deck }) => {
    const room = rooms[(code || '').toUpperCase()];
    if (!room) return io.to(socket.id).emit('errorMsg', 'ไม่พบห้องนี้');
    if (room.players.length >= 2) return io.to(socket.id).emit('errorMsg', 'ห้องเต็มแล้ว');
    room.players.push(newPlayer(socket.id, socket.data.username, deck));
    socket.join(room.code);
    socket.data.room = room.code;
    io.to(socket.id).emit('joined', { code: room.code });
    broadcast(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.room];
    if (!room || room.players.length < 2 || room.started) return;
    room.started = true;
    room.players.forEach(p => drawCards(room, p, 5));
    addLog(room, 'เกมเริ่มแล้ว! สับเด็ค 50 ใบ แจกมือละ 5 ใบ, Life Card 5 ใบ');
    addLog(room, 'ผู้เล่นคนแรก โจมตีไม่ได้ในเทิร์นแรก');
    broadcast(room);
  });

  function currentPlayer(room) { return room.players[room.turn]; }
  function isMyTurn(room) { return room.players[room.turn] && room.players[room.turn].socketId === socket.id; }

  socket.on('playAvatar', ({ handIndex, discardIndices }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (!isMyTurn(room)) return;
    const p = currentPlayer(room);
    if (p.playedAvatar) return addLog(room, 'อัญเชิญ Avatar ได้แค่ 1 ใบต่อเทิร์น'), broadcast(room);
    if (p.field.length >= MAX_FIELD) return addLog(room, 'Avatar Zone เต็มแล้ว (สูงสุด 4 ใบ)'), broadcast(room);
    const card = p.hand[handIndex];
    if (!card || card.type !== 'avatar') return;

    const discIdx = Array.isArray(discardIndices) ? [...new Set(discardIndices)].filter(i => i !== handIndex) : [];
    const gemTotal = discIdx.reduce((sum, i) => sum + ((p.hand[i] && p.hand[i].gem) || 0), 0);
    if (gemTotal < (card.cost || 0)) return addLog(room, `Gem ไม่พอ (ต้องการ ${card.cost}, มี ${gemTotal})`), broadcast(room);

    const removeSet = new Set([...discIdx, handIndex]);
    const discardedCards = discIdx.map(i => p.hand[i]);
    p.hand = p.hand.filter((_, i) => !removeSet.has(i));
    p.graveyard.push(...discardedCards);
    p.field.push({ uid: nextUid(), id: card.id, name: card.name, power: card.power, image: card.image, cost: card.cost, gem: card.gem, text: card.text || '' });
    p.playedAvatar = true;
    addLog(room, `${p.name} ทิ้ง ${discIdx.length} ใบ (Gem ${gemTotal}) อัญเชิญ ${card.name} (Power ${card.power})`);
    broadcast(room);
  });

  socket.on('playMagic', ({ handIndex, targetUid }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (!isMyTurn(room)) return;
    const casterIdx = room.turn;
    const p = currentPlayer(room);
    const card = p.hand[handIndex];
    if (!card || card.type !== 'magic') return;
    if (card.subtype === 'counter') return addLog(room, `${card.name} ใช้ได้เฉพาะตอนถูกโจมตีเท่านั้น`), broadcast(room);
    if (p.playedMagic) return addLog(room, 'ใช้เวทได้แค่ 1 ใบต่อเทิร์น'), broadcast(room);
    p.hand.splice(handIndex, 1);
    if (card.subtype === 'land') room.landZone = { name: card.name, text: card.text || '', by: casterIdx };
    applyMagic(room, casterIdx, targetUid, card);
    p.playedMagic = true;
    checkWin(room);
    broadcast(room);
  });

  socket.on('setCounter', ({ handIndex }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    const meIdx = room.players.findIndex(pl => pl.socketId === socket.id);
    if (meIdx === -1) return;
    const p = room.players[meIdx];
    const card = p.hand[handIndex];
    if (!card || card.type !== 'magic' || card.subtype !== 'counter') return;
    p.hand.splice(handIndex, 1);
    p.counterPending = { kind: card.effect.kind, value: card.effect.value, name: card.name };
    p.graveyard.push(card);
    addLog(room, `${p.name} เตรียม ${card.name} ไว้โต้กลับ`);
    broadcast(room);
  });

  socket.on('attack', ({ attackerUid, targetUid }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (!isMyTurn(room)) return;
    if (room.firstTurn) return addLog(room, 'เทิร์นแรกของเกม โจมตีไม่ได้'), broadcast(room);
    const atkIdx = room.turn;
    const attacker = room.players[atkIdx];
    const defender = room.players[1 - atkIdx];
    const a = attacker.field.find(f => f.uid === attackerUid);
    if (!a || a.attacked) return;

    if (!targetUid && defender.field.length > 0) {
      return addLog(room, 'ต้องโจมตี Avatar ของศัตรูก่อน ถึงจะตี Life Card ได้'), broadcast(room);
    }

    const counter = defender.counterPending;
    if (counter && counter.kind === 'counter_negate') {
      defender.counterPending = null;
      a.attacked = true;
      addLog(room, `${defender.name} ใช้ ${counter.name}: ยกเลิกการโจมตีของ ${a.name}`);
      broadcast(room);
      return;
    }
    let powerReduction = 0;
    if (counter && counter.kind === 'counter_reduce') {
      defender.counterPending = null;
      powerReduction = counter.value;
      addLog(room, `${defender.name} ใช้ ${counter.name}: ลด Power การโจมตีนี้ลง ${counter.value}`);
    }

    a.attacked = true;
    const effPower = Math.max(0, a.power - powerReduction);

    if (!targetUid) {
      dealLifeDamage(room, defender, 1);
      addLog(room, `${attacker.name}: ${a.name} โจมตีตรง! ${defender.name} เสีย Life Card (เหลือ ${Math.max(defender.life, 0)})`);
    } else {
      const d = defender.field.find(f => f.uid === targetUid);
      if (!d) return;
      addLog(room, `${a.name} (Power ${effPower}) ปะทะ ${d.name} (Power ${d.power})`);
      if (effPower > d.power) {
        defender.field = defender.field.filter(f => f.uid !== targetUid);
        defender.graveyard.push(d);
        addLog(room, `${d.name} ถูกทำลาย`);
      } else if (d.power > effPower) {
        attacker.field = attacker.field.filter(f => f.uid !== attackerUid);
        attacker.graveyard.push(a);
        addLog(room, `${a.name} ถูกทำลาย`);
      } else {
        defender.field = defender.field.filter(f => f.uid !== targetUid);
        defender.graveyard.push(d);
        attacker.field = attacker.field.filter(f => f.uid !== attackerUid);
        attacker.graveyard.push(a);
        addLog(room, `Power เท่ากัน — ถูกทำลายทั้งคู่`);
      }
    }
    checkWin(room);
    broadcast(room);
  });

  socket.on('endTurn', () => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (!isMyTurn(room)) return;
    const p = currentPlayer(room);
    p.field.forEach(f => { f.attacked = false; });
    p.playedAvatar = false;
    p.playedMagic = false;
    room.firstTurn = false;
    room.turn = 1 - room.turn;
    const next = currentPlayer(room);
    addLog(room, `${next.name} เริ่มเทิร์นใหม่ (จั่ว 1 ใบ)`);
    drawCards(room, next, 1);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const p = room.players.find(pl => pl.socketId === socket.id);
    if (p) { addLog(room, `${p.name} หลุดการเชื่อมต่อ`); p.socketId = null; broadcast(room); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Battle of Talingchan server running on port ${PORT}`));
