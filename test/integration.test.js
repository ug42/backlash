'use strict';
/* Plays a whole round over real WebSockets against a spawned server. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 39000 + Math.floor(Math.random() * 500);
let proc;

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, state: null, joined: null, all: [], errors: [], waiters: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'joined') c.joined = m;
    if (m.t === 'error') c.errors.push(m.msg);
    if (m.t === 'state') { c.state = m; c.all.push(raw.toString()); }
    c.waiters = c.waiters.filter((w) => !(w.pred(c) && (w.resolve(), true)));
  });
  c.send = (m) => ws.send(JSON.stringify(m));
  c.until = (pred, ms = 8000) => new Promise((resolve, reject) => {
    if (pred(c)) return resolve();
    const h = setTimeout(() => reject(new Error('timed out waiting; phase=' + (c.state && c.state.phase))), ms);
    c.waiters.push({ pred, resolve: () => { clearTimeout(h); resolve(); } });
  });
  c.open = new Promise((res) => ws.on('open', res));
  return c;
}

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DEAL_MS: '60000', TICK_MS: '60000', DECLARE_MS: '60000' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res) => proc.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); }));
});
test.after(() => proc.kill());

test('serves the client and a health check', async () => {
  const page = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Backlash/);
  const h = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
  assert.equal(h.ok, true);
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/../package.json`)).status, 404);
});

test('two humans and three bots play a full round; springs stay private until the reveal', async () => {
  const a = client(); const b = client();
  await a.open; await b.open;
  a.send({ t: 'create', name: 'Alice' });
  await a.until((c) => c.state && c.state.phase === 'LOBBY');
  const code = a.state.code;
  b.send({ t: 'join', name: 'Bob', code });
  await b.until((c) => c.state && c.state.players.length === 2);

  // Only the host can add bots or start; four players is not enough.
  b.send({ t: 'addBot' });
  await b.until((c) => c.errors.length === 1);
  for (let i = 0; i < 2; i++) a.send({ t: 'addBot' });
  await a.until((c) => c.state.players.length === 4);
  a.send({ t: 'start' });
  await a.until((c) => c.errors.length === 1);
  a.send({ t: 'addBot' });
  await a.until((c) => c.state.players.length === 5);
  a.send({ t: 'start' });
  await a.until((c) => c.state.phase === 'DEAL');
  await b.until((c) => c.state.phase === 'DEAL');
  assert.ok([1, -1].includes(a.state.game.dealSide));
  assert.ok(a.state.game.faceplate);

  a.send({ t: 'ready' }); b.send({ t: 'ready' });
  await a.until((c) => c.state.phase === 'TICK');
  assert.equal(a.state.game.dealSide, null, 'direction is hidden after the deal');

  for (let tick = 1; tick <= 3; tick++) {
    await a.until((c) => c.state.phase === 'TICK' && c.state.game.tick === tick && c.state.game.history.length === tick);
    await b.until((c) => c.state.phase === 'TICK' && c.state.game.tick === tick && c.state.game.history.length === tick);
    const others = (c) => c.state.players.filter((p) => p.id !== c.state.you.id);
    a.send({ t: 'twist', target: others(a)[0].id, dir: 1 });
    b.send({ t: 'twist', target: others(b)[1].id, dir: -1 });
    await a.until((c) => c.state.game.choice);
    await b.until((c) => c.state.game.choice);
    a.send({ t: 'ready' }); b.send({ t: 'ready' });
    await a.until((c) => c.state.game.history.length === tick + 1);
  }
  await a.until((c) => c.state.phase === 'DECLARE');
  await b.until((c) => c.state.phase === 'DECLARE');
  assert.equal(a.state.game.table.length, 3);
  assert.ok(a.state.game.history[1].lines.some((l) => /tightness/.test(l)));

  // Nothing sent so far may expose any spring position or another player's faceplate.
  for (const c of [a, b]) for (const raw of c.all) {
    assert.ok(!/"(idx|dealIdx|finalIdx|positions|finalSide|reveal)":\s*[\[{0-9-]/.test(raw.replace('"reveal":null', '')), 'leaked private state: ' + raw.slice(0, 200));
  }

  a.send({ t: 'declare', side: 1 }); b.send({ t: 'declare', side: -1 });
  await a.until((c) => c.state.phase === 'REVEAL');
  await b.until((c) => c.state.phase === 'REVEAL');
  const r = a.state.reveal;
  assert.equal(r.players.length, 5);
  assert.equal(r.ticks.length, 3);
  assert.ok(['headcount', 'declarations', 'tightness', 'draw', 'rust'].includes(r.how));
  const winners = r.players.filter((p) => p.won).map((p) => p.id);
  for (const p of a.state.players) assert.equal(p.score, winners.includes(p.id) ? 1 : 0);

  // Reconnect with the saved token mid-session.
  const tokenB = b.joined.token;
  b.ws.close();
  await a.until((c) => c.state.players.find((p) => p.name === 'Bob' && !p.connected));
  const b2 = client(); await b2.open;
  b2.send({ t: 'rejoin', code, token: tokenB });
  await b2.until((c) => c.state && c.state.phase === 'REVEAL');
  assert.equal(b2.state.you.name, 'Bob');

  a.send({ t: 'lobby' });
  await a.until((c) => c.state.phase === 'LOBBY');
  assert.equal(a.state.game, null);
  a.ws.close(); b2.ws.close();
});
