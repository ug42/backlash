'use strict';
/**
 * Backlash server: serves the static client and runs game rooms over one
 * WebSocket endpoint (/ws). All state is in memory; a restart ends open games.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const ROOM_IDLE_MS = 10 * 60 * 1000;

const rooms = new Map();      // code -> Room
const sockets = new Map();    // playerId -> ws

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function send(playerId, msg) {
  const ws = sockets.get(playerId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws) => {
  let room = null; let pid = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const attach = (r, p) => {
    room = r; pid = p.id;
    const old = sockets.get(pid);
    if (old && old !== ws) { old.replaced = true; old.close(4000, 'replaced'); }
    sockets.set(pid, ws);
    ws.send(JSON.stringify({ t: 'joined', code: r.code, id: p.id, token: p.token }));
  };

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try {
      switch (m.t) {
        case 'ping': ws.send('{"t":"pong"}'); break;
        case 'create': {
          if (room) break;
          if (rooms.size >= MAX_ROOMS) throw new Error('The server is full. Try again in a few minutes.');
          const r = new Room(newCode(), send);
          rooms.set(r.code, r);
          const p = r.addPlayer(m.name);
          attach(r, p); r.sendTo(p.id);
          break;
        }
        case 'join': {
          if (room) break;
          const r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) throw new Error('No room with that code.');
          const p = r.addPlayer(m.name);
          attach(r, p); r.broadcast();
          break;
        }
        case 'rejoin': {
          if (room) break;
          const r = rooms.get(String(m.code || '').toUpperCase().trim());
          const p = r && r.players.find((q) => q.token && q.token === m.token);
          if (!p) { ws.send(JSON.stringify({ t: 'gone' })); break; }
          attach(r, p); r.setConnected(p.id, true);
          break;
        }
        case 'addBot': room && room.addBot(pid); break;
        case 'removeBot': room && room.removeBot(pid); break;
        case 'start': room && room.start(pid, { learning: !!m.learning }); break;
        case 'twist': room && room.choose(pid, m.target, m.dir); break;
        case 'ready': room && room.ready(pid); break;
        case 'declare': room && room.declare(pid, m.side); break;
        case 'lobby': room && room.toLobby(pid); break;
        case 'leave': ws.close(1000, 'left'); break;
        default: break;
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', msg: e.message || 'Something went wrong.' }));
    }
  });

  ws.on('close', () => {
    if (!room || !pid || ws.replaced) return;
    if (sockets.get(pid) === ws) sockets.delete(pid);
    room.setConnected(pid, false);
  });
});

// Drop dead sockets and empty rooms.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.empty() && now - r.touched > ROOM_IDLE_MS) { r.destroy(); rooms.delete(code); }
  }
}, 30000).unref();

server.listen(PORT, () => console.log(`Backlash listening on :${PORT}`));

module.exports = { server, rooms };
