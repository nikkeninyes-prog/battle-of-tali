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

// ---------- Where data lives ----------
// By default this points at ./data inside the app folder, which Render wipes and
// re-creates from scratch on every new deploy (fresh git checkout = fresh container).
// Set DATA_DIR to a Render Persistent Disk mount path (e.g. /var/data) in the
// Environment tab to make accounts, decks, and card edits survive redeploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DATA_PATH = path.join(DATA_DIR, 'cards.json');
const DECKS_PATH = path.join(DATA_DIR, 'decks.json');
const ACCOUNTS_PATH = path.join(DATA_DIR, 'accounts.json');

// Seed cards.json from the copy shipped in the repo the first time this data dir is used
// (e.g. first boot after attaching a fresh Persistent Disk) so the game isn't empty.
if (!fs.existsSync(DATA_PATH)) {
  const shippedCards = path.join(__dirname, 'data', 'cards.json');
  fs.writeFileSync(DATA_PATH, fs.existsSync(shippedCards) ? fs.readFileSync(shippedCards) : '[]');
}
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

// Per-card deck limit: normally 4, "onlyOne" cards cap at 1, and any card can override
// with an explicit `maxCopies` field (e.g. ความเจริญ caps at 2) regardless of type.
function maxCopiesFor(card) {
  if (!card) return MAX_COPIES;
  if (card.maxCopies !== undefined) return card.maxCopies;
  return card.onlyOne ? 1 : MAX_COPIES;
}

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
    const maxAllowed = maxCopiesFor(def);
    if (!Number.isInteger(entry.count) || entry.count < 1 || entry.count > maxAllowed) {
      return res.status(400).json({ error: `${def.name} ใส่ได้ 1-${maxAllowed} ใบ${maxAllowed < MAX_COPIES ? ` (จำกัดพิเศษ)` : ''}` });
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
    const copies = Math.min(maxCopiesFor(c), c.type === 'avatar' ? 3 : 2);
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
    const maxAllowed = maxCopiesFor(def);
    if (!def || !Number.isInteger(entry.count) || entry.count < 1 || entry.count > maxAllowed) return null;
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

// ธรณีสูบ: mill N cards from the top of the deck straight to the graveyard (no reveal/choice).
// Also checks each milled card for mill-triggered abilities (av14 offer-to-reanimate, av15 chain-mill).
function millCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    if (player.deck.length === 0) {
      player.lost = true;
      addLog(room, `${player.name} ธรณีสูบไม่ได้ (เด็คหมด) — แพ้!`);
      checkWin(room);
      return;
    }
    const milled = player.deck.pop();
    player.graveyard.push(milled);
    if (milled.ability && milled.ability.kind === 'cast_from_pit_on_mill' && !milled.pitUseSpent) {
      milled.uid = milled.uid || nextUid();
      milled.castableFromPit = true;
      addLog(room, `${milled.name} ถูกธรณีสูบ: สามารถใช้การ์ดใบนี้จากหลุมได้`);
    }
    if (milled.ability && milled.ability.kind === 'chain_mill_on_mill' && !room.pendingChoice) {
      addLog(room, `${milled.name} ถูกธรณีสูบ: ทั้งสองฝ่าย ธรณีสูบ ${milled.ability.value} ใบเพิ่ม`);
      room.players.forEach(pl => millCards(room, pl, milled.ability.value));
    }
    if (milled.ability && milled.ability.kind === 'reanimate_from_pit_on_mill' && !room.pendingChoice && player.field.length < MAX_FIELD) {
      milled.uid = nextUid();
      addLog(room, `${milled.name} ถูกธรณีสูบ: ${player.name} สามารถอัญเชิญกลับขึ้นสนามได้ทันที`);
      openChoice(room, room.players.indexOf(player), 'reanimate_from_pit_offer', { cardUid: milled.uid, sourceName: milled.name });
    }
  }
}

// All avatar destruction should funnel through here so "prevent destroy" / "replace with halve"
// abilities can intercept before the card actually leaves the field.
// owner = the player whose field the avatar is on. Returns true if actually destroyed.
function destroyAvatar(room, owner, avatarUid, reason) {
  const avatar = owner.field.find(f => f.uid === avatarUid);
  if (!avatar) return false;

  if (owner.counterPending && owner.counterPending.kind === 'prevent_destroy') {
    const counterName = owner.counterPending.name;
    owner.counterPending = null;
    addLog(room, `${owner.name} ใช้ ${counterName}: ${avatar.name} ไม่ถูกทำลาย!`);
    return false;
  }
  if (avatar.ability && avatar.ability.kind === 'replace_destroy_halve' && !avatar.replaceDestroyUsed) {
    avatar.replaceDestroyUsed = true;
    avatar.basePower = Math.floor(avatar.basePower / 2);
    addLog(room, `${avatar.name}: แทนที่จะถูกทำลาย ลด Power ตั้งต้นลงครึ่งหนึ่งเหลือ ${avatar.basePower} (ใช้ได้ครั้งเดียว)`);
    return false;
  }

  owner.field = owner.field.filter(f => f.uid !== avatarUid);
  owner.graveyard.push(avatar);
  addLog(room, `${avatar.name} ถูกทำลาย${reason ? ` (${reason})` : ''}`);
  return true;
}

// Recomputes each avatar's effective power = basePower + continuous ability bonuses + temp modifiers.
// Called before combat math and before every broadcast so display/combat always use fresh numbers.
function recomputePowers(room) {
  room.players.forEach((p) => {
    p.field.forEach(f => {
      let bonus = 0;
      if (f.ability && f.ability.kind === 'tribe_count_buff') {
        const count = p.field.filter(x => x.tribe === f.ability.countTribe).length;
        bonus += (f.ability.value || 0) * count;
      }
      if (f.ability && f.ability.kind === 'graveyard_name_count_buff') {
        const count = p.graveyard.filter(x => x.name && x.name.startsWith(f.ability.countNamePrefix)).length;
        bonus += (f.ability.value || 0) * count;
      }
      const tempSum = (f.tempMods || []).reduce((s, m) => s + m.value, 0);
      f.power = Math.max(0, (f.basePower !== undefined ? f.basePower : f.power) + bonus + tempSum);
    });
  });
}

// Normal draw is 1 card; if hand is completely empty at draw time, draw 3 instead (mercy rule).
function drawAmountFor(player) {
  return player.hand.length === 0 ? 3 : 1;
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
  const you = room.players.findIndex(p => p.socketId === forSocketId);
  let pendingChoice = null;
  if (room.pendingChoice) {
    if (room.pendingChoice.forPlayerIdx === you) pendingChoice = room.pendingChoice;
    else pendingChoice = { waitingForOpponent: true };
  }
  return {
    code: room.code, started: room.started, turn: room.turn, phase: room.phase,
    firstTurn: room.firstTurn, winner: room.winner !== undefined ? room.winner : null,
    landZone: room.landZone || null, pendingChoice,
    log: room.log.slice(-30), players,
    you
  };
}

function broadcast(room) { recomputePowers(room); room.players.forEach(p => { if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.socketId)); }); }
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

function applyMagic(room, casterIdx, targetUid, card, discardedExtra) {
  const caster = room.players[casterIdx];
  const opponent = room.players[1 - casterIdx];
  const eff = card.effect || {};
  switch (eff.kind) {
    case 'field_buff': {
      [caster, opponent].forEach(pl => pl.field.forEach(f => { f.basePower = Math.max(0, f.basePower + eff.value); }));
      addLog(room, `${caster.name} ใช้ ${card.name}: Power ทุกตัวในสนาม ${eff.value >= 0 ? '+' : ''}${eff.value}`);
      break;
    }
    case 'buff_power': {
      const target = caster.field.find(f => f.uid === targetUid);
      if (target) {
        target.basePower += eff.value;
        if (!target.attachments) target.attachments = [];
        target.attachments.push(card.name);
        addLog(room, `${caster.name} ใช้ ${card.name} กับ ${target.name}: Power +${eff.value}`);
      }
      break;
    }
    case 'weapon_tribe_restricted_buff': { // mg11 หอกแหลมแทง ทุกวันทุกวัน
      const target = caster.field.find(f => f.uid === targetUid);
      if (!target) break;
      if (eff.restrictTribe && target.tribe !== eff.restrictTribe) {
        addLog(room, `${card.name} ใส่ได้เฉพาะ Avatar เผ่า${eff.restrictTribe} เท่านั้น`);
        break;
      }
      target.basePower += eff.value;
      if (!target.attachments) target.attachments = [];
      target.attachments.push(card.name);
      addLog(room, `${caster.name} ใช้ ${card.name} กับ ${target.name}: Power +${eff.value}`);
      break;
    }
    case 'damage': {
      const target = opponent.field.find(f => f.uid === targetUid);
      if (target) {
        target.basePower -= eff.value;
        addLog(room, `${caster.name} ใช้ ${card.name} ใส่ ${target.name}: Power -${eff.value}`);
        if (target.basePower <= 0) destroyAvatar(room, opponent, target.uid);
      }
      break;
    }
    case 'heal_life': {
      caster.life = Math.min(START_LIFE, caster.life + eff.value);
      if (caster.life > 0) caster.critical = false;
      addLog(room, `${caster.name} ใช้ ${card.name}: ฟื้น Life Card +${eff.value}`);
      break;
    }
    case 'draw_cards': {
      const before = caster.hand.length;
      drawCards(room, caster, eff.value);
      const drew = caster.hand.length - before;
      addLog(room, `${caster.name} ใช้ ${card.name}: จั่วการ์ด ${drew} ใบ`);
      break;
    }
    case 'buff_self_destroy': {
      const target = caster.field.find(f => f.uid === targetUid);
      if (target) {
        target.basePower += eff.value;
        target.destroyEndOfTurn = true;
        addLog(room, `${caster.name} ใช้ ${card.name} กับ ${target.name}: Power +${eff.value} (จะถูกทำลายตอน End Phase)`);
      }
      break;
    }
    case 'draw_on_attacked': {
      const target = caster.field.find(f => f.uid === targetUid);
      if (target) {
        if (!target.attachments) target.attachments = [];
        if (!target.triggers) target.triggers = [];
        target.attachments.push(card.name);
        target.triggers.push({ kind: 'draw_on_attacked', value: eff.value });
        addLog(room, `${caster.name} สวมใส่ ${card.name} ให้ ${target.name}`);
      }
      break;
    }
    case 'land_tribe_buff': {
      // like field_buff but only affects avatars of a specific tribe, on either side (e.g. เขาไกรลาส -> เทพ)
      [caster, opponent].forEach(pl => pl.field.forEach(f => {
        if (f.tribe === eff.tribe) f.basePower = Math.max(0, f.basePower + eff.value);
      }));
      addLog(room, `${caster.name} ใช้ ${card.name}: Power Avatar เผ่า${eff.tribe} ทุกใบ ${eff.value >= 0 ? '+' : ''}${eff.value}`);
      break;
    }
    case 'destroy_all_opponent': {
      const targets = [...opponent.field];
      targets.forEach(t => destroyAvatar(room, opponent, t.uid));
      addLog(room, `${caster.name} ใช้ ${card.name}: ทำลาย Avatar ฝ่ายตรงข้ามทั้งหมด (${targets.length} ใบ)`);
      break;
    }
    case 'mutual_mill': {
      millCards(room, caster, eff.value);
      millCards(room, opponent, eff.value);
      addLog(room, `${caster.name} ใช้ ${card.name}: ทั้งสองฝ่าย ธรณีสูบ ${eff.value} ใบ`);
      break;
    }
    case 'discard_cost_destroy': { // mg08 บีมมมมมมมมมม
      const target = opponent.field.find(f => f.uid === targetUid);
      if (target) {
        destroyAvatar(room, opponent, target.uid, card.name);
        addLog(room, `${caster.name} ทิ้ง ${discardedExtra ? discardedExtra.name : '1 ใบ'} ใช้ ${card.name}`);
      }
      break;
    }
    case 'discard_avatar_cost_mill_draw': { // mg09 กระทะทองแดง
      millCards(room, caster, eff.millValue);
      const before = caster.hand.length;
      drawCards(room, caster, eff.drawValue);
      addLog(room, `${caster.name} ส่ง ${discardedExtra ? discardedExtra.name : 'Avatar'} ลงหลุม ใช้ ${card.name}: ธรณีสูบ ${eff.millValue} ใบ จั่ว ${caster.hand.length - before} ใบ`);
      break;
    }
    case 'bounce_to_hand': { // mg13 ร้อนมากก็เปิดหน้าต่างสิว่ากกก
      const target = opponent.field.find(f => f.uid === targetUid);
      if (target) {
        opponent.field = opponent.field.filter(f => f.uid !== targetUid);
        const cardBack = { id: target.id, name: target.name, type: 'avatar', tribe: target.tribe, ability: target.ability, cost: target.cost, gem: target.gem, power: target.basePower, text: target.text, image: target.image };
        opponent.hand.push(cardBack);
        addLog(room, `${caster.name} ใช้ ${card.name}: นำ ${target.name} ของ ${opponent.name} กลับมือ`);
      }
      break;
    }
    case 'recycle_pit_to_deck': { // mg14 แหมกำบ้าย
      if (caster.deck.length > (eff.deckThreshold || 15)) {
        addLog(room, `${caster.name}: เด็คยังเหลือมากกว่า ${eff.deckThreshold || 15} ใบ ใช้ ${card.name} ไม่ได้ผล`);
        break;
      }
      const options = caster.graveyard.filter(c => c !== card).map(c => { if (!c.uid) c.uid = nextUid(); return { uid: c.uid, name: c.name }; });
      if (options.length) openChoice(room, casterIdx, 'recycle_pit_to_deck', { sourceName: card.name, maxSelect: eff.maxSelect || 5, options });
      break;
    }
    default:
      addLog(room, `${caster.name} ใช้ ${card.name}`);
  }
  caster.graveyard.push(card);
}

// Opens a choice for a specific player; game pauses (other actions blocked) until resolveChoice arrives.
function openChoice(room, forPlayerIdx, pendingType, extra) {
  room.pendingChoice = { forPlayerIdx, pendingType, ...extra };
}

// Builds the combined list of {uid,name,power,tribe,ownerIdx} avatars from both fields, for "any field" choices.
function allFieldAvatars(room) {
  const list = [];
  room.players.forEach((p, idx) => p.field.forEach(f => list.push({ uid: f.uid, name: f.name, power: f.power, tribe: f.tribe, ownerIdx: idx })));
  return list;
}

function findAvatarAnywhere(room, uid) {
  for (let idx = 0; idx < room.players.length; idx++) {
    const f = room.players[idx].field.find(x => x.uid === uid);
    if (f) return { avatar: f, owner: room.players[idx], ownerIdx: idx };
  }
  return null;
}

function resolvePendingChoice(room, pc, selectedUids) {
  const player = room.players[pc.forPlayerIdx];
  const opponent = room.players[1 - pc.forPlayerIdx];
  const pick = selectedUids[0];

  switch (pc.pendingType) {
    case 'on_summon_target': { // av12 พระอิศวร (-4), av13 พระอินทร์ (+3)
      if (!pick) break;
      const found = findAvatarAnywhere(room, pick);
      if (found) {
        if (!found.avatar.tempMods) found.avatar.tempMods = [];
        found.avatar.tempMods.push({ value: pc.value });
        addLog(room, `${player.name} ใช้จุติของ ${pc.sourceName}: ${found.avatar.name} Power ${pc.value >= 0 ? '+' : ''}${pc.value} จนจบเทิร์น`);
      }
      break;
    }
    case 'dig_choose': { // av05 พระอินทร์เทพขยัน
      const chosen = pc.revealed.find(c => c.uid === pick);
      const rest = pc.revealed.filter(c => c.uid !== pick);
      if (chosen) { delete chosen.uid; player.hand.push(chosen); }
      rest.forEach(c => { delete c.uid; player.deck.push(c); });
      player.deck = shuffle(player.deck);
      addLog(room, `${player.name} จุติ${pc.sourceName}: เปิด ${pc.revealed.length} ใบ เลือก ${chosen ? chosen.name : '(ไม่เลือก)'} เข้ามือ ที่เหลือสับกลับเด็ค`);
      break;
    }
    case 'destroy_field_card': { // av09 พระอิศวร เทพผู้ทำลาย (จุติ + Main Phase)
      if (!pick) break;
      const found = findAvatarAnywhere(room, pick);
      if (found) destroyAvatar(room, found.owner, found.avatar.uid, pc.sourceName);
      break;
    }
    case 'reanimate_named_from_pit': { // av19 พญายม
      if (!pick) break;
      const idx = player.graveyard.findIndex(c => c.uid === pick || c.id === pick);
      if (idx >= 0 && player.field.length < MAX_FIELD) {
        const card = player.graveyard[idx];
        player.graveyard.splice(idx, 1);
        player.field.push({
          uid: nextUid(), id: card.id, name: card.name, image: card.image, cost: card.cost, gem: card.gem, text: card.text || '',
          tribe: card.tribe || null, ability: card.ability || null, basePower: card.power, power: card.power, tempMods: []
        });
        addLog(room, `${player.name} ใช้จุติของ ${pc.sourceName}: ฟื้น ${card.name} จากหลุมขึ้นสนาม`);
      }
      break;
    }
    case 'copy_ability_from_pit': { // av23 มฤตยูเทวี
      if (!pick) break;
      const source = player.graveyard.find(c => c.uid === pick || c.id === pick);
      const self = player.field.find(f => f.uid === pc.selfUid);
      if (source && self) {
        self.ability = source.ability || null;
        addLog(room, `${player.name}: ${self.name} ได้รับความสามารถของ ${source.name} จากหลุม`);
      }
      break;
    }
    case 'reanimate_from_pit_offer': { // av14 นายนิรยบาล แว่น — yes/no
      if (pick === 'yes' && player.field.length < MAX_FIELD) {
        const idx = player.graveyard.findIndex(c => c.uid === pc.cardUid);
        if (idx >= 0) {
          const card = player.graveyard[idx];
          player.graveyard.splice(idx, 1);
          player.field.push({
            uid: nextUid(), id: card.id, name: card.name, image: card.image, cost: card.cost, gem: card.gem, text: card.text || '',
            tribe: card.tribe || null, ability: card.ability || null, basePower: card.power, power: card.power, tempMods: []
          });
          addLog(room, `${player.name}: ${card.name} ฟื้นจากหลุมขึ้นสนามทันทีหลังธรณีสูบ`);
        }
      }
      break;
    }
    case 'sacrifice_to_wake': { // av22 ไอ้ดำ จากนรก — yes(with sacrifice uid)/no
      if (pick && pick !== 'no') {
        const sacrificed = player.field.find(f => f.uid === pick);
        const winner = player.field.find(f => f.uid === pc.winnerUid);
        if (sacrificed && winner) {
          destroyAvatar(room, player, sacrificed.uid, 'สังเวยให้ไอ้ดำ');
          winner.attacked = false;
          addLog(room, `${player.name}: สังเวย ${sacrificed.name} เพื่อให้ ${winner.name} กลับมาสภาพตื่น`);
        }
      }
      break;
    }
    case 'redirect_attack_target': { // mg15
      if (!pick) break;
      const newTarget = player.field.find(f => f.uid === pick);
      if (newTarget) {
        addLog(room, `${player.name} เลือก ${newTarget.name} รับการโจมตีแทน`);
        performAttack(room, pc.attackerIdx, pc.attackerUid, newTarget.uid);
        return; // performAttack already broadcasts; skip the generic broadcast below
      }
      break;
    }
    case 'recycle_pit_to_deck': { // mg14 แหมกำบ้าย
      const chosen = player.graveyard.filter(c => selectedUids.includes(c.uid));
      player.graveyard = player.graveyard.filter(c => !selectedUids.includes(c.uid));
      chosen.forEach(c => { delete c.uid; player.deck.push(c); });
      player.deck = shuffle(player.deck);
      addLog(room, `${player.name} ใช้ ${pc.sourceName}: นำการ์ด ${chosen.length} ใบจากหลุมกลับเข้าเด็คแล้วสับ`);
      break;
    }
    case 'discard_for_conditional_destroy': { // mg10 จิ้มมันเลย จิ้ม!
      if (pick === 'skip' || !pick) break;
      const handIdx = parseInt(pick, 10);
      const discardCard = player.hand[handIdx];
      if (discardCard) {
        player.hand.splice(handIdx, 1);
        player.graveyard.push(discardCard);
        millCards(room, player, pc.millValue);
        const targetFound = findAvatarAnywhere(room, pc.targetUid);
        if (targetFound) destroyAvatar(room, targetFound.owner, pc.targetUid, pc.sourceName);
        addLog(room, `${player.name} ใช้ ${pc.sourceName}: ทิ้ง ${discardCard.name} ธรณีสูบ ${pc.millValue} ใบ และทำลาย Avatar ที่เพิ่งอัญเชิญ`);
      }
      break;
    }
    default:
      break;
  }
}

function performAttack(room, atkIdx, attackerUid, targetUid) {
  const attacker = room.players[atkIdx];
  const defender = room.players[1 - atkIdx];
  const a = attacker.field.find(f => f.uid === attackerUid);
  if (!a || a.attacked) return;

  if (!targetUid && defender.field.length > 0) {
    return addLog(room, 'ต้องโจมตี Avatar ของศัตรูก่อน ถึงจะตี Life Card ได้'), broadcast(room);
  }

  const targetAvatar = targetUid ? defender.field.find(f => f.uid === targetUid) : null;
  const counterBlocked = targetAvatar && targetAvatar.ability && targetAvatar.ability.kind === 'block_counter_on_attacked';
  const counter = counterBlocked ? null : defender.counterPending;
  if (counterBlocked && defender.counterPending) {
    addLog(room, `${targetAvatar.name}: ฝ่ายตรงข้ามใช้การ์ด Counter ช่วยไม่ได้`);
  }

  // mg15 "โจมตีตัวจันให้โดนถากหาเธอทำได้" — redirect this attack to a defender-chosen avatar
  if (counter && counter.kind === 'redirect_attack' && defender.field.length > 0) {
    defender.counterPending = null;
    addLog(room, `${defender.name} เตรียมใช้ ${counter.name}: เลือก Avatar ใหม่ให้รับการโจมตีแทน`);
    openChoice(room, 1 - atkIdx, 'redirect_attack_target', { attackerIdx: atkIdx, attackerUid, sourceName: counter.name });
    broadcast(room);
    return;
  }

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
  if (counter && counter.kind === 'reduce_by_cardcount') {
    defender.counterPending = null;
    const cardCount = defender.field.length + defender.hand.length;
    powerReduction = counter.value * cardCount;
    addLog(room, `${defender.name} ใช้ ${counter.name}: ลด Power ผู้โจมตีลง ${powerReduction} (${counter.value} x ${cardCount} ใบ)`);
  }

  a.attacked = true;

  if (!targetUid) {
    dealLifeDamage(room, defender, 1);
    const drawAmt = drawAmountFor(defender) + 1;
    const before = defender.hand.length;
    drawCards(room, defender, drawAmt);
    const drew = defender.hand.length - before;
    addLog(room, `${attacker.name}: ${a.name} โจมตีตรง! ${defender.name} เสีย Life Card (เหลือ ${Math.max(defender.life, 0)}) และจั่วการ์ด ${drew} ใบ`);
  } else {
    const d = defender.field.find(f => f.uid === targetUid);
    if (!d) return;
    if (d.triggers && d.triggers.some(t => t.kind === 'draw_on_attacked')) {
      d.triggers.filter(t => t.kind === 'draw_on_attacked').forEach(t => {
        const before = defender.hand.length;
        drawCards(room, defender, t.value);
        addLog(room, `${d.name} โดนโจมตี: ${defender.name} จั่วการ์ด ${defender.hand.length - before} ใบ (ขวานทอง)`);
      });
    }
    if (d.ability && d.ability.kind === 'self_buff_on_attacked') {
      if (!d.tempMods) d.tempMods = [];
      d.tempMods.push({ value: d.ability.value });
      addLog(room, `${d.name} โดนโจมตี: Power +${d.ability.value} จนจบเทิร์น`);
    }
    recomputePowers(room);
    const effPower = Math.max(0, a.power - powerReduction);
    addLog(room, `${a.name} (Power ${effPower}) ปะทะ ${d.name} (Power ${d.power})`);
    if (effPower > d.power) {
      destroyAvatar(room, defender, d.uid);
      if (a.ability && a.ability.kind === 'sacrifice_to_wake_after_win' && attacker.field.length > 0) {
        openChoice(room, atkIdx, 'sacrifice_to_wake', { winnerUid: a.uid, sourceName: a.name });
      }
    } else if (d.power > effPower) {
      destroyAvatar(room, attacker, a.uid);
    } else {
      addLog(room, `Power เท่ากัน — ถูกทำลายทั้งคู่`);
      destroyAvatar(room, defender, d.uid);
      destroyAvatar(room, attacker, a.uid);
    }
  }
  checkWin(room);
  broadcast(room);
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
    const room = { code, players: [newPlayer(socket.id, socket.data.username, deck)], started: false, turn: 0, phase: 'main', firstTurn: true, log: [], winner: undefined, pendingChoice: null };
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
    const first = room.players[room.turn];
    drawCards(room, first, drawAmountFor(first));
    addLog(room, 'เกมเริ่มแล้ว! สับเด็ค 50 ใบ แจกมือละ 5 ใบ, Life Card 5 ใบ');
    addLog(room, `${first.name} จั่วการ์ดเริ่มเทิร์นแรก`);
    addLog(room, 'ผู้เล่นคนแรก โจมตีไม่ได้ในเทิร์นแรก');
    broadcast(room);
  });

  function currentPlayer(room) { return room.players[room.turn]; }
  function isMyTurn(room) { return room.players[room.turn] && room.players[room.turn].socketId === socket.id; }

  socket.on('playAvatar', ({ handIndex, discardIndices }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    if (!isMyTurn(room)) return;
    const p = currentPlayer(room);
    if (p.playedAvatar) return addLog(room, 'อัญเชิญ Avatar ได้แค่ 1 ใบต่อเทิร์น'), broadcast(room);
    if (p.field.length >= MAX_FIELD) return addLog(room, 'Avatar Zone เต็มแล้ว (สูงสุด 4 ใบ)'), broadcast(room);
    const card = p.hand[handIndex];
    if (!card || card.type !== 'avatar') return;

    const discIdx = Array.isArray(discardIndices)
      ? [...new Set(discardIndices)].filter(i => Number.isInteger(i) && i !== handIndex && i >= 0 && i < p.hand.length)
      : [];
    const gemTotal = discIdx.reduce((sum, i) => sum + ((p.hand[i] && p.hand[i].gem) || 0), 0);
    if (gemTotal < (card.cost || 0)) return addLog(room, `Gem ไม่พอ (ต้องการ ${card.cost}, มี ${gemTotal})`), broadcast(room);

    const removeSet = new Set([...discIdx, handIndex]);
    const discardedCards = discIdx.map(i => p.hand[i]);
    p.hand = p.hand.filter((_, i) => !removeSet.has(i));
    p.graveyard.push(...discardedCards);
    const newAvatar = {
      uid: nextUid(), id: card.id, name: card.name, image: card.image, cost: card.cost, gem: card.gem, text: card.text || '',
      tribe: card.tribe || null, ability: card.ability || null,
      basePower: card.power, power: card.power, tempMods: []
    };
    p.field.push(newAvatar);
    p.playedAvatar = true;
    addLog(room, `${p.name} ทิ้ง ${discIdx.length} ใบ (Gem ${gemTotal}) อัญเชิญ ${card.name} (Power ${card.power})`);

    // av02 พระลักษมี — a discarded cost card can grant a temporary buff to a specifically-named summon
    discardedCards.forEach(dc => {
      if (dc.ability && dc.ability.kind === 'cost_synergy_buff' && (!dc.ability.restrictTribe || newAvatar.tribe === dc.ability.restrictTribe) && newAvatar.name === dc.ability.targetName) {
        newAvatar.tempMods.push({ value: dc.ability.value });
        addLog(room, `${dc.name} ถูกใช้จ่าย Cost ให้ ${newAvatar.name}: Power +${dc.ability.value} จนจบเทิร์น`);
      }
    });

    // "อุบัติเหตุ!!!" / mg10 style traps: opponent may have a counter armed that reacts to our summon
    const opponent = room.players[1 - room.turn];
    if (opponent.counterPending && opponent.counterPending.kind === 'destroy_opp_summon') {
      p.field = p.field.filter(f => f.uid !== newAvatar.uid);
      p.graveyard.push(newAvatar);
      addLog(room, `${opponent.name} ใช้ ${opponent.counterPending.name}: ทำลาย ${newAvatar.name} ที่เพิ่งอัญเชิญ!`);
      opponent.counterPending = null;
      broadcast(room);
      return;
    }
    if (opponent.counterPending && opponent.counterPending.kind === 'conditional_discard_destroy_mill') {
      const cp = opponent.counterPending;
      const qualifying = opponent.hand.map((c, i) => ({ c, i })).filter(x => x.c.type === 'avatar' && x.c.tribe === cp.restrictTribe && x.c.cost >= newAvatar.cost);
      if (qualifying.length > 0) {
        addLog(room, `${opponent.name} มีสิทธิ์ใช้ ${cp.name} ใส่ ${newAvatar.name}`);
        openChoice(room, 1 - room.turn, 'discard_for_conditional_destroy', {
          targetUid: newAvatar.uid, millValue: cp.millValue, sourceName: cp.name,
          options: qualifying.map(x => ({ handIndex: x.i, name: x.c.name }))
        });
        broadcast(room);
        return;
      }
    }

    // On-summon (จุติ) triggers for the newly summoned avatar itself
    const ab = newAvatar.ability;
    if (ab) {
      if (ab.kind === 'buff_target_end_of_turn' || ab.kind === 'debuff_target_end_of_turn') {
        const targets = allFieldAvatars(room);
        if (targets.length) openChoice(room, room.turn, 'on_summon_target', { value: ab.value, sourceName: newAvatar.name, options: targets });
      } else if (ab.kind === 'dig_choose') {
        const revealed = [];
        for (let i = 0; i < (ab.value || 3) && p.deck.length; i++) revealed.push(p.deck.pop());
        revealed.forEach(c => { c.uid = nextUid(); });
        if (revealed.length) openChoice(room, room.turn, 'dig_choose', { revealed, sourceName: newAvatar.name });
      } else if (ab.kind === 'destroy_field_card' && ab.trigger && ab.trigger.startsWith('on_summon')) {
        const targets = allFieldAvatars(room).filter(t => t.uid !== newAvatar.uid);
        if (targets.length) openChoice(room, room.turn, 'destroy_field_card', { sourceName: `จุติของ ${newAvatar.name}`, options: targets });
      } else if (ab.kind === 'reanimate_named_from_pit') {
        const options = p.graveyard.filter(c => c.name && c.name.startsWith(ab.targetNamePrefix)).map(c => ({ uid: c.uid || c.id, name: c.name }));
        if (options.length && p.field.length < MAX_FIELD) openChoice(room, room.turn, 'reanimate_named_from_pit', { sourceName: newAvatar.name, options });
      } else if (ab.kind === 'copy_ability_from_pit') {
        const options = p.graveyard.filter(c => c.tribe === ab.restrictTribe).map(c => ({ uid: c.uid || c.id, name: c.name }));
        if (options.length) openChoice(room, room.turn, 'copy_ability_from_pit', { selfUid: newAvatar.uid, sourceName: newAvatar.name, options });
      }
    }
    broadcast(room);
  });

  socket.on('playMagic', ({ handIndex, targetUid, discardIndex }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    if (!isMyTurn(room)) return;
    const casterIdx = room.turn;
    const p = currentPlayer(room);
    const card = p.hand[handIndex];
    if (!card || card.type !== 'magic') return;
    if (card.subtype === 'counter') return addLog(room, `${card.name} ใช้ได้เฉพาะตอนถูกโจมตีเท่านั้น`), broadcast(room);
    if (p.playedMagic) return addLog(room, 'ใช้เวทได้แค่ 1 ใบต่อเทิร์น'), broadcast(room);

    // discard-as-additional-cost cards (mg08, mg09) need a specific hand card discarded alongside casting
    const eff = card.effect || {};
    let discardedExtra = null;
    if (eff.kind === 'discard_cost_destroy' || eff.kind === 'discard_avatar_cost_mill_draw') {
      if (discardIndex === undefined || discardIndex === handIndex) return addLog(room, `${card.name} ต้องเลือกการ์ดทิ้งเป็นค่าใช้จ่ายเพิ่ม`), broadcast(room);
      const discCard = p.hand[discardIndex];
      if (!discCard) return;
      if (eff.kind === 'discard_avatar_cost_mill_draw' && (discCard.type !== 'avatar' || discCard.tribe !== eff.restrictTribe)) {
        return addLog(room, `ต้องทิ้ง Avatar เผ่า${eff.restrictTribe} เท่านั้น`), broadcast(room);
      }
      discardedExtra = discCard;
    }

    // mg17 ชายจากอนาคต — opponent may have this counter armed to negate any Magic cast entirely
    const opponent = room.players[1 - casterIdx];
    if (opponent.counterPending && opponent.counterPending.kind === 'negate_magic_cast') {
      const counterName = opponent.counterPending.name;
      opponent.counterPending = null;
      p.hand.splice(handIndex, 1);
      if (discardedExtra !== null) { p.hand.splice(discardIndex > handIndex ? discardIndex - 1 : discardIndex, 1); p.graveyard.push(discardedExtra); }
      p.graveyard.push(card);
      p.playedMagic = true;
      addLog(room, `${opponent.name} ใช้ ${counterName}: ยกเลิกความสามารถของ ${card.name}`);
      broadcast(room);
      return;
    }

    // remove hand cards (higher index first so indices stay valid)
    const indicesToRemove = discardedExtra !== null ? [handIndex, discardIndex].sort((a, b) => b - a) : [handIndex];
    indicesToRemove.forEach(i => p.hand.splice(i, 1));
    if (discardedExtra !== null) p.graveyard.push(discardedExtra);

    if (card.subtype === 'land') room.landZone = { name: card.name, text: card.text || '', by: casterIdx };
    applyMagic(room, casterIdx, targetUid, card, discardedExtra);
    p.playedMagic = true;
    checkWin(room);
    broadcast(room);
  });

  // หอกแหลมแทง ทุกวันทุกวัน (and any future card with the same ability): once ธรณีสูบ sends it to the
  // pit, it can be cast directly from there instead of needing to be in hand.
  socket.on('playMagicFromPit', ({ cardUid, targetUid }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    if (!isMyTurn(room)) return;
    const p = currentPlayer(room);
    if (p.playedMagic) return addLog(room, 'ใช้เวทได้แค่ 1 ใบต่อเทิร์น'), broadcast(room);
    const idx = p.graveyard.findIndex(c => c.uid === cardUid);
    if (idx === -1) return;
    const card = p.graveyard[idx];
    if (!card.castableFromPit) return addLog(room, `${card.name} ยังใช้จากหลุมไม่ได้`), broadcast(room);
    p.graveyard.splice(idx, 1);
    card.castableFromPit = false;
    card.pitUseSpent = true;
    addLog(room, `${p.name} ใช้ ${card.name} จากหลุม`);
    applyMagic(room, room.turn, targetUid, card, null);
    p.playedMagic = true;
    checkWin(room);
    broadcast(room);
  });

  socket.on('setCounter', ({ handIndex }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    const meIdx = room.players.findIndex(pl => pl.socketId === socket.id);
    if (meIdx === -1) return;
    const p = room.players[meIdx];
    const card = p.hand[handIndex];
    if (!card || card.type !== 'magic' || card.subtype !== 'counter') return;
    p.hand.splice(handIndex, 1);
    p.counterPending = { ...card.effect, name: card.name };
    p.graveyard.push(card);
    addLog(room, `${p.name} เตรียม ${card.name} ไว้โต้กลับ`);
    broadcast(room);
  });

  socket.on('attack', ({ attackerUid, targetUid }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    if (!isMyTurn(room)) return;
    if (room.firstTurn) return addLog(room, 'เทิร์นแรกของเกม โจมตีไม่ได้'), broadcast(room);
    performAttack(room, room.turn, attackerUid, targetUid);
  });

  socket.on('endTurn', () => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    if (!isMyTurn(room)) return;
    const p = currentPlayer(room);
    const toDestroy = p.field.filter(f => f.destroyEndOfTurn);
    if (toDestroy.length) {
      p.field = p.field.filter(f => !f.destroyEndOfTurn);
      toDestroy.forEach(f => { p.graveyard.push(f); addLog(room, `${f.name} ถูกทำลายตอน End Phase (ความกล้าหาญ)`); });
    }
    p.field.forEach(f => { f.attacked = false; });
    room.players.forEach(pl => pl.field.forEach(f => { f.tempMods = []; })); // "จนจบเทิร์น" buffs/debuffs expire here for both sides
    p.playedAvatar = false;
    p.playedMagic = false;
    room.firstTurn = false;
    room.turn = 1 - room.turn;
    const next = currentPlayer(room);
    next.field.forEach(f => { f.usedMainPhaseAbility = false; });
    const amt = drawAmountFor(next);
    drawCards(room, next, amt);
    addLog(room, `${next.name} เริ่มเทิร์นใหม่ (จั่ว ${amt} ใบ${amt === 3 ? ' — มือว่างพอดี' : ''})`);
    broadcast(room);
  });

  socket.on('activateAbility', ({ avatarUid }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.started || room.winner !== undefined) return;
    if (room.pendingChoice) return;
    if (!isMyTurn(room)) return;
    const p = currentPlayer(room);
    const av = p.field.find(f => f.uid === avatarUid);
    if (!av || !av.ability || av.ability.kind !== 'destroy_field_card') return;
    if (!av.ability.trigger || !av.ability.trigger.includes('main_phase')) return;
    if (av.usedMainPhaseAbility) return addLog(room, `${av.name} ใช้ความสามารถนี้ไปแล้วในเทิร์นนี้`), broadcast(room);
    av.usedMainPhaseAbility = true;
    const targets = allFieldAvatars(room).filter(t => t.uid !== av.uid);
    if (targets.length) openChoice(room, room.turn, 'destroy_field_card', { sourceName: `${av.name} (Main Phase)`, options: targets });
    broadcast(room);
  });

  socket.on('resolveChoice', ({ selectedUids }) => {
    const room = rooms[socket.data.room];
    if (!room || !room.pendingChoice) return;
    const meIdx = room.players.findIndex(pl => pl.socketId === socket.id);
    if (meIdx !== room.pendingChoice.forPlayerIdx) return;
    const pc = room.pendingChoice;
    room.pendingChoice = null;
    resolvePendingChoice(room, pc, Array.isArray(selectedUids) ? selectedUids : [selectedUids]);
    checkWin(room);
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
