'use strict';
/**
 * Backlash rules engine. Pure functions over a plain state object; no I/O.
 *
 * Track index 0..5  <->  W3 W2 W1 | S1 S2 S3
 * side: +1 Sunwise (index >= 3), -1 Widdershins.
 * A twist with dir +1 turns the target Sunwise by one step and recoils the
 * twister one step Widdershins (and the reverse for dir -1).
 */

const SETUPS = {
  5: ['BalanceWheel', 'Listener', 'Echo', 'Rust', 'Mainspring'],
  6: ['BalanceWheel', 'Listener', 'Echo', 'Surveyor', 'Rust', 'Cog'],
  7: ['BalanceWheel', 'Listener', 'Cracked', 'Echo', 'Rust', 'Mainspring', 'Decoy'],
  8: ['BalanceWheel', 'Listener', 'Cracked', 'Echo', 'Surveyor', 'Rust', 'Decoy', 'Cog'],
  9: ['BalanceWheel', 'Listener', 'Cracked', 'Echo', 'Surveyor', 'Watchmaker', 'Rust', 'Mainspring', 'Decoy'],
};
const LOOSE = new Set(['BalanceWheel', 'Listener', 'Cracked', 'Echo', 'Surveyor', 'Watchmaker', 'Rust']);
/** Random events: one is drawn for each tick at the deal and announced when that tick begins. */
const EVENTS = {
  calm: { name: 'Calm', text: 'Nothing unusual this tick.' },
  slip: { name: 'Slipped Gear', text: 'After the twists land, one random spring slips a step toward the midline. A spring at tightness 1 slips across.' },
  stiff: { name: 'Stiff Springs', text: 'This tick every crossing needs two hands, even on a key at tightness 1.' },
  greased: { name: 'Greased Springs', text: 'This tick every twist moves its target 2 steps. The recoil is still 1 step.' },
  scramble: { name: 'Scramble', text: 'After this tick two random players swap faceplates.' },
  fog: { name: 'Fog', text: 'No Chime is announced for this tick.' },
  stuck: { name: 'Stuck Dial', text: 'One random dial does not update this tick.' },
};
const EVENT_DECK = ['calm', 'calm', 'slip', 'stiff', 'greased', 'scramble', 'fog', 'stuck'];
const INFO = ['BalanceWheel', 'Listener', 'Echo', 'Surveyor', 'Watchmaker'];
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 9;
const TICKS = 3;

const side = (i) => (i >= 3 ? 1 : -1);
const tight = (i) => (i >= 3 ? i - 2 : 3 - i);
const idxOf = (s, t) => (s > 0 ? 2 + t : 3 - t);
const clamp = (i) => Math.max(0, Math.min(5, i));
const inRange = (i) => i >= 0 && i <= 5;

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pick = (a, rng) => a[Math.floor(rng() * a.length)];

/** Three different events for the three ticks. A Scramble never lands on the last tick. */
function drawEvents(rng) {
  const deck = shuffle(EVENT_DECK.slice(), rng);
  const out = [];
  for (const e of deck) {
    if (out.length === TICKS) break;
    if (e !== 'calm' && out.includes(e)) continue;
    if (e === 'scramble' && out.length === TICKS - 1) continue;
    out.push(e);
  }
  while (out.length < TICKS) out.push('calm');
  return out;
}

/**
 * Draw a random set of faceplates. Always one Rust, the Mainspring at odd counts,
 * at least two information plates, and a Cracked Listener only beside a real one.
 */
function drawPlates(n, rng) {
  const fixed = ['Rust'].concat(n % 2 ? ['Mainspring'] : []);
  const pool = INFO.concat(['Decoy', 'Cog', 'Cog'], n >= 7 ? ['Cracked'] : []);
  let picked = shuffle(pool.slice(), rng).slice(0, n - fixed.length);
  const rest = () => pool.filter((r) => r === 'Cog' || !picked.includes(r));
  if (picked.includes('Cracked') && !picked.includes('Listener')) picked[picked.indexOf('Cracked')] = 'Listener';
  while (picked.filter((r) => INFO.includes(r)).length < 2) {
    const add = rest().find((r) => INFO.includes(r));
    const out = picked.findIndex((r) => !INFO.includes(r));
    picked[out] = add;
  }
  return shuffle(fixed.concat(picked), rng);
}

/** What a holder is told their faceplate is. The Cracked Listener looks like a Listener. */
const shownRole = (role) => (role === 'Cracked' ? 'Listener' : role);

/**
 * Deal a round.
 * @param {number} n players (5..9)
 * @param {() => number} rng
 * @param {{learning?: boolean, variety?: boolean, events?: boolean}} [opts]
 *   learning: everyone is a Cog; variety: random faceplate set; events: random tick events
 */
function deal(n, rng = Math.random, opts = {}) {
  if (n < MIN_PLAYERS || n > MAX_PLAYERS) throw new Error('Backlash needs 5 to 9 players');
  let roles = opts.learning ? Array(n).fill('Cog')
    : opts.variety ? drawPlates(n, rng) : shuffle(SETUPS[n].slice(), rng);
  const big = rng() < 0.5 ? 1 : -1;
  const sides = shuffle(
    Array(Math.ceil(n / 2)).fill(big).concat(Array(Math.floor(n / 2)).fill(-big)), rng);
  const odd = n % 2 === 1;
  // At odd counts the Mainspring sits on the smaller side.
  const m = roles.indexOf('Mainspring');
  if (odd && m >= 0 && sides[m] === big) {
    const small = sides.map((s, i) => (s === -big ? i : -1)).filter((i) => i >= 0);
    const j = pick(small, rng);
    [roles[m], roles[j]] = [roles[j], roles[m]];
  }
  const players = sides.map((s, i) => ({
    idx: idxOf(s, roles[i] === 'Mainspring' ? 3 : 2),
    role: roles[i],
    dealRole: roles[i],
    dealSide: s,
    loose: false,
  }));
  // Loose key(s): larger-side players who start at tightness 1.
  if (odd) {
    const cands = shuffle(players.filter((p) => p.dealSide === big && p.role !== 'Mainspring'), rng);
    const k = n === 9 ? 2 : 1;
    cands.slice(0, k).forEach((p) => { p.idx = idxOf(big, 1); p.loose = true; });
  }
  players.forEach((p) => { p.dealIdx = p.idx; p.shown = tight(p.idx); });
  const events = opts.events && !opts.learning ? drawEvents(rng) : Array(TICKS).fill('calm');
  return { n, players, tick: 0, sham: null, log: [], learning: !!opts.learning, larger: odd ? big : 0, events };
}

/** Move a key by its incoming twists, applying the hands rule and the track ends. */
function applyIncoming(start, incoming, sideBefore, event) {
  if (!incoming.length) return start;
  const net = incoming.reduce((a, t) => a + t.steps, 0);
  if (net === 0) return start;
  const dir = Math.sign(net);
  let next = start + net;
  const crosses = (start <= 2 && next >= 3) || (start >= 3 && next <= 2);
  if (crosses) {
    // Only twists from players on the side the key is pulled toward count as hands.
    const hands = incoming.filter((t) => Math.sign(t.steps) === dir && sideBefore[t.from] === dir).length;
    const need = tight(start) === 1 && event !== 'stiff' ? 1 : 2;
    if (hands < need) next = start <= 2 ? 2 : 3;
  }
  return clamp(next);
}

/**
 * Resolve one tick.
 * @param state from deal()
 * @param {(null|{target:number, dir:1|-1})[]} actions one per seat; null = idle
 * @returns the tick record (also pushed to state.log) with per-seat reports
 */
function resolveTick(state, actions, rng = Math.random) {
  const { n, players } = state;
  if (state.tick >= TICKS) throw new Error('round is over');
  const tickNo = state.tick;
  const event = (state.events && state.events[tickNo]) || 'calm';
  const before = players.map((p) => p.idx);
  const sideBefore = before.map(side);
  const rolesBefore = players.map((p) => p.role);

  // 1-2. Idle players and jams, each twist judged alone against start-of-tick positions.
  const twists = [];
  const idle = [];
  for (let i = 0; i < n; i++) {
    const a = actions[i];
    const ok = a && Number.isInteger(a.target) && a.target >= 0 && a.target < n && a.target !== i &&
      (a.dir === 1 || a.dir === -1);
    if (!ok) { idle.push(i); continue; }
    const jammed = !(inRange(before[a.target] + a.dir) && inRange(before[i] - a.dir));
    twists.push({ from: i, target: a.target, dir: a.dir, jammed });
  }
  const live = twists.filter((t) => !t.jammed);

  // Own recoil first.
  const pos = before.slice();
  for (const t of live) pos[t.from] = before[t.from] - t.dir;

  // Incoming twists per target.
  const inc = Array.from({ length: n }, () => []);
  for (const t of live) inc[t.target].push({ from: t.from, steps: t.dir * (event === 'greased' ? 2 : 1) });

  // 3. The Decoy's tick 1 sham reverses on its target at the end of tick 2.
  let reversal = null;
  if (tickNo === 0) {
    const d = live.find((t) => players[t.from].role === 'Decoy');
    if (d) state.sham = { actor: d.from, target: d.target, dir: d.dir };
  } else if (tickNo === 1 && state.sham) {
    const s = state.sham;
    const own = inc[s.target].find((t) => t.from === s.actor);
    if (own) own.steps += -2 * s.dir; else inc[s.target].push({ from: s.actor, steps: -2 * s.dir });
    reversal = { actor: s.actor, target: s.target };
  }

  // 4-5. Move every spring.
  for (let i = 0; i < n; i++) pos[i] = applyIncoming(pos[i], inc[i].filter((t) => t.steps !== 0), sideBefore, event);

  // 6. Overwind: more than a third of the table tried to tighten a spring already at 2 or 3.
  let snap = null;
  const tighteners = twists.filter((t) => t.dir === -sideBefore[t.from] && tight(before[t.from]) >= 2).map((t) => t.from);
  if (tighteners.length > n / 3) {
    snap = pick(tighteners, rng);
    pos[snap] = idxOf(-side(pos[snap]), 1);
  }

  // Slipped Gear: one random spring slips a step toward the midline, or across it from tightness 1.
  let slip = null;
  if (event === 'slip') {
    slip = Math.floor(rng() * n);
    const sd = side(pos[slip]); const t = tight(pos[slip]);
    pos[slip] = t > 1 ? idxOf(sd, t - 1) : idxOf(-sd, 1);
  }

  players.forEach((p, i) => { p.idx = pos[i]; });
  const chime = players.filter((p, i) => side(p.idx) !== sideBefore[i]).length;

  // 8. Private reports, using the faceplates held during the tick.
  const rustHolder = rolesBefore.indexOf('Rust');
  const rustTwist = twists.find((t) => t.from === rustHolder);
  const frozen = rustTwist ? rustTwist.target : -1;
  const stuck = event === 'stuck' ? Math.floor(rng() * n) : -1;
  const reports = players.map((p, i) => {
    if (i !== frozen && i !== stuck) p.shown = tight(p.idx);
    const mine = twists.find((t) => t.from === i);
    const info = [];
    const role = rolesBefore[i];
    if (role === 'BalanceWheel') info.push({ kind: 'balance', side: side(p.idx), tightness: tight(p.idx) });
    if (mine) {
      const tg = mine.target;
      if (role === 'Listener') info.push({ kind: 'listener', target: tg, side: side(players[tg].idx) });
      if (role === 'Cracked') info.push({ kind: 'listener', target: tg, side: -side(players[tg].idx) });
      if (role === 'Echo') info.push({ kind: 'echo', target: tg, side: sideBefore[tg] });
      if (role === 'Watchmaker') {
        info.push({ kind: 'watchmaker', target: tg, others: twists.filter((t) => t.target === tg && t.from !== i).map((t) => t.from) });
      }
      if (role === 'Rust') info.push({ kind: 'rust', target: tg });
    }
    if (role === 'Surveyor') {
      const sun = players.filter((q) => side(q.idx) > 0).length;
      info.push({ kind: 'surveyor', sunwise: sun, widdershins: n - sun });
    }
    if (reversal && reversal.actor === i) {
      const tw = twists.find((t) => t.from === reversal.target);
      info.push({ kind: 'decoy', target: reversal.target, twist: tw ? { target: tw.target, dir: tw.dir } : null });
    }
    return { tightness: p.shown, jammed: !!(mine && mine.jammed), idle: !mine, info, newRole: null, oldRole: null };
  });

  // 9. Loose faceplates hop after ticks 1 and 2, in seat order, at most once each.
  const hops = [];
  let scramble = null;
  if (tickNo < TICKS - 1) {
    const moved = new Set();
    for (let i = 0; i < n; i++) {
      const mine = twists.find((t) => t.from === i);
      const r = players[i].role;
      if (!mine || !LOOSE.has(r) || moved.has(r)) continue;
      const q = players[mine.target];
      const back = q.role;
      players[i].role = back; q.role = r;
      moved.add(r); if (LOOSE.has(back)) moved.add(back);
      hops.push({ from: i, to: mine.target, plate: r, back });
    }
    if (event === 'scramble') {
      const a = Math.floor(rng() * n); let b = Math.floor(rng() * (n - 1)); if (b >= a) b++;
      [players[a].role, players[b].role] = [players[b].role, players[a].role];
      scramble = [a, b];
    }
    players.forEach((p, i) => {
      if (p.role !== rolesBefore[i]) { reports[i].newRole = p.role; reports[i].oldRole = rolesBefore[i]; }
    });
  }

  const record = {
    tick: tickNo + 1, twists, idle, before, positions: players.map((p) => p.idx), snap, chime,
    overwind: snap !== null, frozen, stuck, slip, scramble, event, reversal, hops, roles: players.map((p) => p.role), reports,
  };
  state.log.push(record);
  state.tick++;
  return record;
}

/**
 * Score a finished round.
 * @param {(1|-1|null)[]} declarations per seat; null counts as the dealt side
 */
function score(state, declarations) {
  const { players, n } = state;
  const final = players.map((p) => side(p.idx));
  const decl = players.map((p, i) => (declarations[i] === 1 || declarations[i] === -1 ? declarations[i] : p.dealSide));
  const seized = players.map((p, i) => decl[i] !== final[i]);
  const rustHolder = players.findIndex((p) => p.role === 'Rust');
  const flippedAndWrong = players.filter((p, i) => i !== rustHolder && seized[i] && final[i] !== p.dealSide).length;
  const count = { 1: final.filter((s) => s === 1).length, [-1]: final.filter((s) => s === -1).length };
  const base = { final, decl, seized, rustHolder, flippedAndWrong, count };
  if (rustHolder >= 0 && flippedAndWrong >= 2) {
    return { ...base, rustWin: true, winSide: 0, how: 'rust', winners: [rustHolder] };
  }
  let winSide = 0; let how = 'headcount';
  if (count[1] !== count[-1]) winSide = count[1] > count[-1] ? 1 : -1;
  else {
    const correct = (s) => players.filter((p, i) => final[i] === s && !seized[i]).length;
    const tension = (s) => players.reduce((a, p, i) => a + (final[i] === s ? tight(p.idx) : 0), 0);
    if (correct(1) !== correct(-1)) { winSide = correct(1) > correct(-1) ? 1 : -1; how = 'declarations'; }
    else if (tension(1) !== tension(-1)) { winSide = tension(1) > tension(-1) ? 1 : -1; how = 'tightness'; }
    else how = 'draw';
  }
  const winners = [];
  if (winSide) for (let i = 0; i < n; i++) if (final[i] === winSide && i !== rustHolder) winners.push(i);
  return { ...base, rustWin: false, winSide, how, winners };
}

module.exports = {
  SETUPS, LOOSE, EVENTS, INFO, MIN_PLAYERS, MAX_PLAYERS, TICKS, drawEvents, drawPlates,
  side, tight, idxOf, shownRole, deal, resolveTick, score, applyIncoming,
};
