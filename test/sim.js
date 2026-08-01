const { io } = require('socket.io-client');

const c1 = io('http://localhost:3000');
const c2 = io('http://localhost:3000');
let s1, s2;

c1.on('connect', () => c1.emit('createRoom', { name: 'P1' }));
c1.on('joined', ({ code }) => { console.log('room code', code); c2.emit('joinRoom', { code, name: 'P2' }); });
c1.on('errorMsg', m => console.log('[P1] ERR', m));
c2.on('errorMsg', m => console.log('[P2] ERR', m));
c1.on('state', s => { s1 = s; });
c2.on('state', s => { s2 = s; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(50);
  }
}

function pickDiscards(hand, avIdx, cost) {
  let need = cost;
  const idxs = [];
  hand.forEach((c, i) => { if (i !== avIdx && need > 0 && c.gem > 0) { idxs.push(i); need -= c.gem; } });
  return idxs;
}

(async () => {
  await waitFor(() => s2 && s2.players.length === 2);
  console.log('--- both joined, starting game ---');
  c1.emit('startGame');
  await waitFor(() => s1 && s1.started && s2 && s2.started);

  console.log('P1 turn:', s1.turn, 'firstTurn:', s1.firstTurn);
  const p1hand = s1.players[s1.you].hand;
  console.log('P1 hand:', p1hand.map(c => `${c.name}(${c.type}${c.type==='avatar'?` cost${c.cost} gem${c.gem} pw${c.power}`:''})`));

  const avIdx = p1hand.findIndex(c => c.type === 'avatar');
  if (avIdx >= 0) {
    const disc = pickDiscards(p1hand, avIdx, p1hand[avIdx].cost);
    const gemTotal = disc.reduce((s,i)=>s+p1hand[i].gem,0);
    console.log(`P1 summons ${p1hand[avIdx].name} (cost ${p1hand[avIdx].cost}) discarding ${disc.length} cards (gem ${gemTotal})`);
    c1.emit('playAvatar', { handIndex: avIdx, discardIndices: disc });
    await sleep(300);
    console.log('P1 field:', s1.players[s1.you].field.map(f=>`${f.name} pw${f.power}`));
  } else {
    console.log('no avatar drawn for P1, skipping summon test');
  }

  console.log('--- P1 tries to attack on first turn (should be rejected) ---');
  if (s1.players[s1.you].field.length) {
    c1.emit('attack', { attackerUid: s1.players[s1.you].field[0].uid, targetUid: null });
    await sleep(300);
    console.log('log after illegal attack attempt:', s1.log.slice(-2));
  }

  console.log('--- ending P1 turn ---');
  c1.emit('endTurn');
  await waitFor(() => s2 && s2.turn === 1);
  console.log('P2 turn now. firstTurn:', s2.firstTurn);

  const p2hand = s2.players[s2.you].hand;
  console.log('P2 hand:', p2hand.map(c => `${c.name}(${c.type}${c.type==='avatar'?` cost${c.cost} gem${c.gem} pw${c.power}`:''})`));
  const avIdx2 = p2hand.findIndex(c => c.type === 'avatar');
  if (avIdx2 >= 0) {
    const disc2 = pickDiscards(p2hand, avIdx2, p2hand[avIdx2].cost);
    console.log(`P2 summons ${p2hand[avIdx2].name} discarding ${disc2.length}`);
    c2.emit('playAvatar', { handIndex: avIdx2, discardIndices: disc2 });
    await sleep(300);
    console.log('P2 field:', s2.players[s2.you].field.map(f=>`${f.name} pw${f.power}`));
  }

  console.log('--- P2 attacks (not first turn, should work if avatar exists) ---');
  const myAv = s2.players[s2.you].field[0];
  const oppField = s2.players[1 - s2.you].field;
  if (myAv && oppField.length) {
    console.log('P2 attacks avatar vs avatar');
    c2.emit('attack', { attackerUid: myAv.uid, targetUid: oppField[0].uid });
  } else if (myAv) {
    console.log('P2 attempts direct attack (opp field empty, should succeed)');
    c2.emit('attack', { attackerUid: myAv.uid, targetUid: null });
  } else {
    console.log('P2 has no avatar to attack with');
  }
  await sleep(400);

  console.log('--- FINAL STATE ---');
  console.log('P1 field:', s1.players[s1.you].field);
  console.log('P2 field:', s2.players[s2.you].field);
  console.log('P1 life:', s1.players[s1.you].life, 'P2 life:', s2.players[s2.you].life);
  console.log('Recent log:', s1.log.slice(-6));

  process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
