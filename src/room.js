'use strict';
/**
 * One game room: lobby, phase timers, private views. No sockets in here; the
 * server passes a `send(playerId, message)` function, which keeps this testable.
 */
const crypto = require('crypto');
const E = require('./engine');

const FAST = process.env.FAST === '1';
const MS = {
  deal: Number(process.env.DEAL_MS) || (FAST ? 4000 : 30000),
  tick: Number(process.env.TICK_MS) || (FAST ? 8000 : 110000),
  declare: Number(process.env.DECLARE_MS) || (FAST ? 5000 : 20000),
};
const BOT_NAMES = ['Ana', 'Bo', 'Cy', 'Dee', 'Eli', 'Fen', 'Gus', 'Hal', 'Ivy'];
const SIDE = { 1: 'Sunwise ↻', [-1]: 'Widdershins ↺' };
const ARROW = { 1: '↻', [-1]: '↺' };
const PLATE_NAME = {
  BalanceWheel: 'Balance Wheel', Listener: 'Listener', Cracked: 'Listener', Echo: 'Echo', Surveyor: 'Surveyor',
  Watchmaker: 'Watchmaker', Rust: 'Rust', Decoy: 'Decoy', Mainspring: 'Mainspring', Cog: 'Cog',
};
const PLATE_TEXT = {
  BalanceWheel: 'After this tick you are told your exact side and tightness. Then this faceplate jumps to the player you twisted.',
  Listener: 'After this tick you learn which side the player you twisted is on. Then this faceplate jumps to them. One Listener in the game may be cracked and report the opposite.',
  Echo: 'After this tick you learn which side your target was on when the tick began. Then this faceplate jumps to them.',
  Surveyor: 'After this tick you learn how many keys are on each side. Then this faceplate jumps to the player you twisted.',
  Watchmaker: 'After this tick you learn who else twisted your target. Then this faceplate jumps to them.',
  Rust: 'You play for Rust while you hold this. The player you twist sees no change on their dial this tick. It jumps to them after ticks 1 and 2. Whoever holds Rust at the end wins alone if two other players were flipped and declare the wrong side.',
  Decoy: 'Your tick 1 twist is a sham. It lands now and reverses on your target by 2 steps at the end of tick 2. You are then shown what your target did in tick 2.',
  Mainspring: 'You start at tightness 3. No other power.',
  Cog: 'No power. Twist well.',
};

const id = (n = 8) => crypto.randomBytes(n).toString('hex');
const joinNames = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

class Room {
  constructor(code, send, rng = Math.random) {
    this.code = code; this.send = send; this.rng = rng;
    this.players = [];            // {id, token, name, isBot, connected, score, ready}
    this.hostId = null;
    this.phase = 'LOBBY';         // LOBBY | DEAL | TICK | DECLARE | REVEAL
    this.learning = false; this.events = true; this.variety = true;
    this.game = null; this.seats = []; this.choices = []; this.decls = [];
    this.history = [];            // per seat: [{tick, lines}]
    this.table = [];              // public per-tick facts
    this.deadline = 0; this.timer = null; this.result = null;
    this.touched = Date.now();
  }

  // ---- membership --------------------------------------------------------
  humans() { return this.players.filter((p) => !p.isBot); }
  find(pid) { return this.players.find((p) => p.id === pid); }

  addPlayer(name) {
    if (this.phase !== 'LOBBY') throw new Error('That game is already in progress.');
    if (this.players.length >= E.MAX_PLAYERS) throw new Error('That room is full.');
    name = String(name || '').trim().slice(0, 16) || 'Player';
    const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
    let nm = name; let k = 2;
    while (taken.has(nm.toLowerCase())) nm = `${name} ${k++}`;
    const p = { id: id(4), token: id(12), name: nm, isBot: false, connected: true, score: 0, ready: false };
    this.players.push(p);
    if (!this.find(this.hostId) || this.find(this.hostId).isBot) this.hostId = p.id;
    this.broadcast();
    return p;
  }

  addBot(byId) {
    this.requireHost(byId); this.requireLobby();
    if (this.players.length >= E.MAX_PLAYERS) throw new Error('The room is full.');
    const used = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n + ' (bot)')) + ' (bot)';
    this.players.push({ id: id(4), token: null, name, isBot: true, connected: true, score: 0, ready: true });
    this.broadcast();
  }

  removeBot(byId) {
    this.requireHost(byId); this.requireLobby();
    const i = this.players.map((p) => p.isBot).lastIndexOf(true);
    if (i >= 0) this.players.splice(i, 1);
    this.broadcast();
  }

  setConnected(pid, on) {
    const p = this.find(pid); if (!p) return;
    p.connected = on; this.touched = Date.now();
    if (!on && this.phase === 'LOBBY') {
      // In the lobby a dropped player simply leaves.
      this.players = this.players.filter((q) => q.id !== pid);
    }
    if (!on && this.hostId === pid) {
      const next = this.humans().find((q) => q.connected && q.id !== pid);
      if (next) this.hostId = next.id;
    }
    this.broadcast();
    if (on) return;
    this.maybeAdvance();
  }

  requireHost(pid) { if (pid !== this.hostId) throw new Error('Only the host can do that.'); }
  requireLobby() { if (this.phase !== 'LOBBY') throw new Error('Not while a round is running.'); }
  empty() { return !this.humans().some((p) => p.connected); }

  // ---- phases ------------------------------------------------------------
  setPhase(phase, ms) {
    clearTimeout(this.timer);
    this.phase = phase;
    this.deadline = ms ? Date.now() + ms : 0;
    this.players.forEach((p) => { p.ready = p.isBot; });
    if (ms) this.timer = setTimeout(() => this.timeUp(), ms);
  }

  start(byId, opts = {}) {
    this.requireHost(byId); this.requireLobby();
    const n = this.players.length;
    if (n < E.MIN_PLAYERS || n > E.MAX_PLAYERS) throw new Error(`Backlash needs ${E.MIN_PLAYERS} to ${E.MAX_PLAYERS} players. Add bots to fill seats.`);
    this.learning = !!opts.learning;
    if (typeof opts.events === 'boolean') this.events = opts.events;
    if (typeof opts.variety === 'boolean') this.variety = opts.variety;
    this.seats = this.players.map((p) => p.id);
    this.game = E.deal(n, this.rng, { learning: this.learning, events: this.events, variety: this.variety });
    this.choices = Array(n).fill(null);
    this.decls = Array(n).fill(null);
    this.table = []; this.result = null;
    this.history = this.game.players.map((gp) => [{
      tick: 0,
      lines: [
        `You are dealt ${SIDE[gp.dealSide]} at tightness ${E.tight(gp.idx)}.`,
        `Faceplate: ${PLATE_NAME[gp.role]}. ${PLATE_TEXT[E.shownRole(gp.role)]}`,
      ].concat(gp.loose ? ['You are a loose key: one opposing twist can flip you.'] : []),
    }]);
    this.setPhase('DEAL', MS.deal);
    this.broadcast();
  }

  seatOf(pid) { return this.seats.indexOf(pid); }

  choose(pid, target, dir) {
    if (this.phase !== 'TICK') return;
    const i = this.seatOf(pid); const t = this.seatOf(target);
    if (i < 0) return;
    if (t < 0 || t === i || (dir !== 1 && dir !== -1)) throw new Error('Pick another player and a direction.');
    this.choices[i] = { target: t, dir };
    this.find(pid).ready = false;
    this.broadcast();
  }

  ready(pid) {
    const p = this.find(pid); const i = this.seatOf(pid);
    if (!p || i < 0) return;
    if (this.phase === 'TICK' && !this.choices[i]) throw new Error('Choose a player and a direction first.');
    if (this.phase === 'DECLARE' && !this.decls[i]) throw new Error('Choose a side first.');
    if (!['DEAL', 'TICK', 'DECLARE'].includes(this.phase)) return;
    p.ready = true;
    this.broadcast();
    this.maybeAdvance();
  }

  declare(pid, s) {
    if (this.phase !== 'DECLARE') return;
    const i = this.seatOf(pid);
    if (i < 0 || (s !== 1 && s !== -1)) return;
    this.decls[i] = s;
    this.find(pid).ready = true;
    this.broadcast();
    this.maybeAdvance();
  }

  /** End a phase early once every connected human is ready. */
  maybeAdvance() {
    if (!['DEAL', 'TICK', 'DECLARE'].includes(this.phase)) return;
    const live = this.humans().filter((p) => p.connected && this.seatOf(p.id) >= 0);
    if (live.length && live.every((p) => p.ready)) this.timeUp();
  }

  timeUp() {
    clearTimeout(this.timer);
    if (this.phase === 'DEAL') { this.setPhase('TICK', MS.tick); this.broadcast(); }
    else if (this.phase === 'TICK') this.resolve();
    else if (this.phase === 'DECLARE') this.finish();
  }

  botChoice(i) {
    const gp = this.game.players[i]; const n = this.game.n;
    let t = Math.floor(this.rng() * (n - 1)); if (t >= i) t++;
    // Recruit toward the dealt side when wound tightly enough, otherwise brace.
    const dir = gp.shown >= 2 ? gp.dealSide : -gp.dealSide;
    return { target: t, dir };
  }

  resolve() {
    const g = this.game;
    const actions = this.seats.map((pid, i) => {
      const p = this.find(pid);
      if (!p) return null;
      if (p.isBot) return this.botChoice(i);
      return p.connected ? this.choices[i] : null;   // a disconnected player idles
    });
    const name = (i) => this.find(this.seats[i]).name;
    const rec = E.resolveTick(g, actions, this.rng);
    rec.reports.forEach((r, i) => {
      const lines = [];
      const a = actions[i];
      if (r.idle) lines.push('You idled: no twist, no recoil.');
      else if (r.jammed) lines.push(`Your twist on ${name(a.target)} jammed. Neither key moved.`);
      else lines.push(`You twisted ${name(a.target)} ${ARROW[a.dir]} and recoiled ${ARROW[-a.dir]}.`);
      lines.push(`Your dial reads tightness ${r.tightness}.`);
      for (const x of r.info) {
        if (x.kind === 'balance') lines.push(`Balance Wheel: you are ${SIDE[x.side]} at tightness ${x.tightness}.`);
        if (x.kind === 'listener') lines.push(`Listener: ${name(x.target)} is now ${SIDE[x.side]}.`);
        if (x.kind === 'echo') lines.push(`Echo: ${name(x.target)} was ${SIDE[x.side]} when the tick began.`);
        if (x.kind === 'surveyor') lines.push(`Surveyor: ${x.sunwise} Sunwise, ${x.widdershins} Widdershins.`);
        if (x.kind === 'watchmaker') lines.push(x.others.length ? `Watchmaker: ${joinNames(x.others.map(name))} also twisted ${name(x.target)}.` : `Watchmaker: nobody else twisted ${name(x.target)}.`);
        if (x.kind === 'rust') lines.push(`Rust: ${name(x.target)}'s dial is frozen this tick.`);
        if (x.kind === 'decoy') lines.push(`Decoy: your sham on ${name(x.target)} has reversed. This tick ${name(x.target)} ${x.twist ? `twisted ${name(x.twist.target)} ${ARROW[x.twist.dir]}` : 'idled'}.`);
      }
      if (r.newRole) lines.push(`Your faceplate changed: ${PLATE_NAME[r.oldRole]} is gone and you now hold ${PLATE_NAME[r.newRole]}. ${PLATE_TEXT[E.shownRole(r.newRole)]}`);
      this.history[i].push({ tick: rec.tick, lines });
    });
    const fog = rec.event === 'fog';
    this.table.push({ tick: rec.tick, event: E.EVENTS[rec.event].name, fog, chime: fog ? null : rec.chime, overwind: fog ? false : rec.overwind, idle: rec.idle.map(name) });
    this.choices = Array(g.n).fill(null);
    if (g.tick >= E.TICKS) this.setPhase('DECLARE', MS.declare);
    else this.setPhase('TICK', MS.tick);
    this.broadcast();
  }

  finish() {
    const g = this.game;
    const decl = this.seats.map((pid, i) => {
      const p = this.find(pid);
      return p && p.isBot ? g.players[i].dealSide : this.decls[i];
    });
    this.result = E.score(g, decl);
    this.result.winners.forEach((i) => { const p = this.find(this.seats[i]); if (p) p.score++; });
    this.setPhase('REVEAL', 0);
    this.broadcast();
  }

  toLobby(byId) {
    this.requireHost(byId);
    if (this.phase !== 'REVEAL') throw new Error('The round is still running.');
    // Drop humans who left mid-round.
    this.players = this.players.filter((p) => p.isBot || p.connected);
    this.game = null; this.seats = [];
    this.setPhase('LOBBY', 0);
    this.broadcast();
  }

  // ---- views -------------------------------------------------------------
  /** Everything one player is allowed to know. Other players' springs are never included before the reveal. */
  view(pid) {
    const me = this.find(pid);
    const i = this.seatOf(pid);
    const v = {
      t: 'state', code: this.code, phase: this.phase, now: Date.now(), deadline: this.deadline,
      hostId: this.hostId, you: me ? { id: me.id, name: me.name } : null, learning: this.learning,
      events: this.events, variety: this.variety,
      min: E.MIN_PLAYERS, max: E.MAX_PLAYERS,
      players: this.players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, connected: p.connected, ready: p.ready, score: p.score, seated: this.seatOf(p.id) >= 0 })),
      game: null, reveal: null,
    };
    if (this.game && i >= 0) {
      const gp = this.game.players[i];
      v.game = {
        tick: Math.min(this.game.tick + 1, E.TICKS), ticks: E.TICKS,
        faceplate: PLATE_NAME[gp.role], faceplateText: PLATE_TEXT[E.shownRole(gp.role)],
        dealSide: this.phase === 'DEAL' ? gp.dealSide : null,
        tightness: gp.shown,
        event: this.phase === 'TICK' && this.game.events[this.game.tick] !== 'calm' ? E.EVENTS[this.game.events[this.game.tick]] : null,
        choice: this.choices[i] ? { target: this.seats[this.choices[i].target], dir: this.choices[i].dir } : null,
        declared: this.decls[i],
        history: this.history[i], table: this.table,
      };
    }
    if (this.phase === 'REVEAL' && this.result) v.reveal = this.revealData();
    return v;
  }

  revealData() {
    const g = this.game; const r = this.result;
    const name = (i) => this.find(this.seats[i]) ? this.find(this.seats[i]).name : '(left)';
    return {
      winSide: r.winSide, how: r.how, rustWin: r.rustWin, count: { sunwise: r.count[1], widdershins: r.count[-1] },
      flippedAndWrong: r.flippedAndWrong,
      players: g.players.map((gp, i) => ({
        id: this.seats[i], name: name(i), dealIdx: gp.dealIdx, finalIdx: gp.idx, dealSide: gp.dealSide,
        finalSide: r.final[i], declared: r.decl[i], seized: r.seized[i], won: r.winners.includes(i),
        dealPlate: PLATE_NAME[gp.dealRole] + (gp.dealRole === 'Cracked' ? ' (cracked)' : ''),
        finalPlate: PLATE_NAME[gp.role] + (gp.role === 'Cracked' ? ' (cracked)' : ''),
        loose: gp.loose, rust: i === r.rustHolder,
      })),
      ticks: g.log.map((rec) => ({
        tick: rec.tick, chime: rec.chime, snap: rec.snap === null ? null : name(rec.snap),
        event: rec.event === 'calm' ? null : E.EVENTS[rec.event].name,
        slip: rec.slip === null ? null : name(rec.slip), stuck: rec.stuck >= 0 ? name(rec.stuck) : null,
        scramble: rec.scramble ? rec.scramble.map(name) : null,
        before: rec.before, crossed: rec.positions.map((x, i) => E.side(x) !== E.side(rec.before[i])),
        plates: rec.roles.map((r) => PLATE_NAME[r] + (r === 'Cracked' ? ' (cracked)' : '')),
        frozen: rec.frozen >= 0 ? name(rec.frozen) : null,
        twists: rec.twists.map((t) => ({ from: name(t.from), target: name(t.target), dir: t.dir, jammed: t.jammed })),
        idle: rec.idle.map(name),
        reversal: rec.reversal ? { actor: name(rec.reversal.actor), target: name(rec.reversal.target) } : null,
        hops: rec.hops.map((h) => ({ from: name(h.from), to: name(h.to), plate: PLATE_NAME[h.plate] + (h.plate === 'Cracked' ? ' (cracked)' : ''), back: PLATE_NAME[h.back] })),
        positions: rec.positions,
      })),
    };
  }

  sendTo(pid) { this.send(pid, this.view(pid)); }
  broadcast() { this.touched = Date.now(); this.humans().forEach((p) => { if (p.connected) this.sendTo(p.id); }); }
  destroy() { clearTimeout(this.timer); }
}

module.exports = { Room, MS };
