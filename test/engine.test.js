'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

const S = (t) => E.idxOf(1, t);   // Sunwise at tightness t
const W = (t) => E.idxOf(-1, t);  // Widdershins at tightness t

/** Build a state by hand: positions and optional roles. */
function make(positions, roles) {
  const players = positions.map((idx, i) => ({
    idx, role: (roles && roles[i]) || 'Cog', dealRole: (roles && roles[i]) || 'Cog',
    dealSide: E.side(idx), dealIdx: idx, loose: false, shown: E.tight(idx),
  }));
  return { n: positions.length, players, tick: 0, sham: null, log: [], learning: false, larger: 0 };
}
const pos = (st) => st.players.map((p) => p.idx);
const never = () => 0.999; // rng that never matters
const idle = (n, acts) => Array.from({ length: n }, (_, i) => acts[i] || null);

test('deal: sizes, Mainspring on the smaller side, loose keys on the larger side', () => {
  for (const n of [5, 6, 7, 8, 9]) {
    for (let k = 0; k < 200; k++) {
      const st = E.deal(n, Math.random);
      const sun = st.players.filter((p) => p.dealSide === 1).length;
      assert.ok(Math.abs(sun - (n - sun)) <= 1);
      assert.deepEqual(st.players.map((p) => p.role).sort(), E.SETUPS[n].slice().sort());
      const loose = st.players.filter((p) => p.loose);
      if (n % 2) {
        const big = sun > n - sun ? 1 : -1;
        const ms = st.players.find((p) => p.role === 'Mainspring');
        assert.equal(ms.dealSide, -big);
        assert.equal(E.tight(ms.idx), 3);
        assert.equal(loose.length, n === 9 ? 2 : 1);
        loose.forEach((p) => { assert.equal(p.dealSide, big); assert.equal(E.tight(p.idx), 1); });
      } else assert.equal(loose.length, 0);
    }
  }
});

test('a twist moves the target one step and recoils the twister the other way', () => {
  const st = make([S(2), W(2), S(2), W(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 } }), never);
  assert.deepEqual(pos(st), [S(1), W(1), S(2), W(2), S(2)]);
});

test('opposite twists on one key cancel', () => {
  const st = make([S(2), W(2), S(2), W(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 4, dir: 1 }, 1: { target: 4, dir: -1 } }), never);
  assert.equal(st.players[4].idx, S(2));
});

test('two hands from the pulling side flip a key at tightness 2', () => {
  const st = make([S(2), S(2), W(2), W(2), S(2)]);
  const rec = E.resolveTick(st, idle(5, { 0: { target: 2, dir: 1 }, 1: { target: 2, dir: 1 } }), never);
  assert.equal(st.players[2].idx, S(1));
  assert.equal(rec.chime, 1);
});

test('one hand cannot flip a key at tightness 2; it stops at 1', () => {
  const st = make([S(3), W(2), S(2), W(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 } }), never);
  assert.equal(st.players[1].idx, W(1));
});

test('one hand from the pulling side flips a key at tightness 1', () => {
  const st = make([S(2), W(1), S(2), W(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 } }), never);
  assert.equal(st.players[1].idx, S(1));
});

test("a teammate's twist never counts as a hand", () => {
  // Seat 0 (Widdershins) betrays seat 1 (Widdershins, tightness 1) toward Sunwise: no flip.
  const st = make([W(2), W(1), S(2), S(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 } }), never);
  assert.equal(st.players[1].idx, W(1));
  // Teammate plus one real opponent on a tightness-2 key: still only one hand.
  const st2 = make([W(2), W(2), S(2), S(2), S(2)]);
  E.resolveTick(st2, idle(5, { 0: { target: 1, dir: 1 }, 2: { target: 1, dir: 1 } }), never);
  assert.equal(st2.players[1].idx, W(1));
});

test('tightness for the one-hand rule is judged after own recoil; mutual recruiters trade sides', () => {
  const st = make([S(2), W(2), S(2), W(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 }, 1: { target: 0, dir: -1 } }), never);
  assert.equal(st.players[0].idx, W(1));
  assert.equal(st.players[1].idx, S(1));
});

test('own recoil can carry a player across the midline', () => {
  const st = make([S(1), W(3), S(2), W(2), S(2)]);
  E.resolveTick(st, idle(5, { 0: { target: 3, dir: 1 } }), never);
  assert.equal(st.players[0].idx, W(1));
});

test('jams: judged per twist against start positions; nobody is singled out', () => {
  // Target already at S3: every Sunwise push jams, nobody recoils.
  // (Seven seats, so two jammed attempts to tighten are not more than a third of the table.)
  const st = make([W(2), W(2), S(3), W(2), S(2), S(2), W(2)]);
  const rec = E.resolveTick(st, idle(7, { 0: { target: 2, dir: 1 }, 1: { target: 2, dir: 1 } }), never);
  assert.deepEqual(pos(st), [W(2), W(2), S(3), W(2), S(2), S(2), W(2)]);
  assert.ok(rec.twists.every((t) => t.jammed));
  assert.ok(rec.reports[0].jammed && rec.reports[1].jammed);
  // Target at S2 pushed by three: none jams, key stops at 3, all three recoil.
  // (Allies shoring up, so the Overwind is not involved.)
  const st2 = make([S(2), S(2), S(2), S(2), W(2)]);
  const rec2 = E.resolveTick(st2, idle(5, { 0: { target: 2, dir: 1 }, 1: { target: 2, dir: 1 }, 3: { target: 2, dir: 1 } }), never);
  assert.ok(rec2.twists.every((t) => !t.jammed));
  assert.deepEqual(pos(st2), [S(1), S(1), S(3), S(1), W(2)]);
});

test('a player at tightness 3 cannot brace: the recoil would overshoot', () => {
  const st = make([S(3), W(2), S(2), W(2), S(2)]);
  const rec = E.resolveTick(st, idle(5, { 0: { target: 1, dir: -1 } }), never);
  assert.ok(rec.twists[0].jammed);
  assert.deepEqual(pos(st), [S(3), W(2), S(2), W(2), S(2)]);
});

test('Overwind fires only when more than a third tighten a spring already at 2 or 3', () => {
  // 6 players; three brace from tightness 2 -> 3 > 6/3 -> snap.
  const st = make([S(2), S(2), S(2), W(2), W(2), W(2)]);
  const acts = idle(6, { 0: { target: 3, dir: -1 }, 1: { target: 4, dir: -1 }, 2: { target: 5, dir: -1 } });
  const rec = E.resolveTick(st, acts, () => 0);
  assert.equal(rec.snap, 0);
  assert.equal(st.players[0].idx, W(1));
  assert.ok(rec.overwind);
  // Two bracers out of six is not more than a third.
  const st2 = make([S(2), S(2), S(2), W(2), W(2), W(2)]);
  const rec2 = E.resolveTick(st2, idle(6, { 0: { target: 3, dir: -1 }, 1: { target: 4, dir: -1 } }), () => 0);
  assert.equal(rec2.snap, null);
  // Bracing from tightness 1 to recover does not count.
  const st3 = make([S(1), S(1), S(1), W(2), W(2), W(2)]);
  const rec3 = E.resolveTick(st3, idle(6, { 0: { target: 3, dir: -1 }, 1: { target: 4, dir: -1 }, 2: { target: 5, dir: -1 } }), () => 0);
  assert.equal(rec3.snap, null);
});

test('information faceplates: Listener, Cracked Listener, Echo, Surveyor, Watchmaker, Balance Wheel', () => {
  const roles = ['Listener', 'Cracked', 'Echo', 'Surveyor', 'Watchmaker', 'BalanceWheel', 'Cog'];
  // Seat 6 is W1 and gets flipped by seat 0's single Sunwise hand.
  const st = make([S(2), S(2), S(2), S(2), W(2), W(2), W(1)], roles);
  const acts = idle(7, {
    0: { target: 6, dir: 1 }, 1: { target: 6, dir: -1 }, 2: { target: 6, dir: 1 },
    4: { target: 6, dir: -1 },
  });
  // net on seat 6: +1 -1 +1 -1 = 0 -> stays W1. Use a simpler flip instead:
  const st2 = make([S(2), S(2), S(2), S(2), W(2), W(2), W(1)], roles);
  const rec = E.resolveTick(st2, idle(7, { 0: { target: 6, dir: 1 }, 1: { target: 6, dir: 1 }, 2: { target: 6, dir: 1 }, 4: { target: 6, dir: -1 } }), never);
  assert.equal(E.side(st2.players[6].idx), 1);
  assert.deepEqual(rec.reports[0].info[0], { kind: 'listener', target: 6, side: 1 });       // true
  assert.deepEqual(rec.reports[1].info[0], { kind: 'listener', target: 6, side: -1 });      // cracked: opposite, same label
  assert.deepEqual(rec.reports[2].info[0], { kind: 'echo', target: 6, side: -1 });          // stale
  assert.equal(rec.reports[3].info[0].kind, 'surveyor');
  assert.equal(rec.reports[3].info[0].sunwise + rec.reports[3].info[0].widdershins, 7);
  assert.deepEqual(rec.reports[4].info[0], { kind: 'watchmaker', target: 6, others: [0, 1, 2] });
  assert.equal(rec.reports[5].info[0].kind, 'balance');
  assert.equal(E.shownRole('Cracked'), 'Listener');
  void st; void acts;
});

test('Rust freezes the dial of the player it twists', () => {
  const st = make([S(2), W(2), S(2), W(2), S(2)], ['Rust', 'Cog', 'Cog', 'Cog', 'Cog']);
  const rec = E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 } }), never);
  assert.equal(st.players[1].idx, W(1));        // it really moved
  assert.equal(rec.reports[1].tightness, 2);    // but the dial still shows 2
  assert.equal(rec.frozen, 1);
});

test('loose faceplates hop to the twisted player after ticks 1 and 2, not after tick 3', () => {
  const st = make([S(2), W(2), S(2), W(2), S(2)], ['Listener', 'Cog', 'Mainspring', 'Decoy', 'Cog']);
  let rec = E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 }, 2: { target: 3, dir: 1 }, 3: { target: 4, dir: -1 } }), never);
  assert.equal(st.players[0].role, 'Cog');
  assert.equal(st.players[1].role, 'Listener');
  assert.equal(st.players[2].role, 'Mainspring'); // fixed plates stay
  assert.equal(st.players[3].role, 'Decoy');
  assert.equal(rec.reports[1].newRole, 'Listener');
  assert.equal(rec.reports[0].newRole, 'Cog');
  rec = E.resolveTick(st, idle(5, { 1: { target: 4, dir: 1 } }), never);
  assert.equal(st.players[4].role, 'Listener');
  rec = E.resolveTick(st, idle(5, { 4: { target: 0, dir: -1 } }), never);
  assert.equal(st.players[4].role, 'Listener'); // nothing moves after tick 3
  assert.deepEqual(rec.hops, []);
});

test('a faceplate moves at most once per tick', () => {
  // Seat 0 (Listener) twists seat 1 (Echo); seat 1 twists seat 2. The Listener must not travel on to seat 2.
  const st = make([S(2), W(2), S(2), W(2), S(2)], ['Listener', 'Echo', 'Cog', 'Cog', 'Cog']);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 }, 1: { target: 2, dir: -1 } }), never);
  assert.equal(st.players[1].role, 'Listener');
  assert.equal(st.players[0].role, 'Echo');
  assert.equal(st.players[2].role, 'Cog');
});

test("the Decoy's sham reverses on its target only, at the end of tick 2, and reveals the target's twist", () => {
  const st = make([W(2), S(2), S(2), W(2), S(2)], ['Decoy', 'Cog', 'Cog', 'Cog', 'Cog']);
  E.resolveTick(st, idle(5, { 0: { target: 1, dir: 1 } }), never);   // sham: seat 1 rises to S3, Decoy recoils to W3
  assert.equal(st.players[1].idx, S(3));
  assert.equal(st.players[0].idx, W(3));
  const rec = E.resolveTick(st, idle(5, { 1: { target: 3, dir: 1 } }), never); // target recruits: recoil to S2
  // reversal: 2 steps Widdershins from S2 with one hand at tightness 2 -> stops at S1
  assert.equal(st.players[1].idx, S(1));
  assert.equal(st.players[0].idx, W(3));        // the Decoy's own spring is not moved
  assert.deepEqual(rec.reports[0].info.find((x) => x.kind === 'decoy'), { kind: 'decoy', target: 1, twist: { target: 3, dir: 1 } });
});

test('scoring: headcount, then correct declarations, then tightness, then draw', () => {
  let st = make([S(2), S(2), S(2), W(2), W(2)]);
  let r = E.score(st, [1, 1, -1, -1, -1]);
  assert.equal(r.winSide, 1); assert.equal(r.how, 'headcount');
  assert.deepEqual(r.winners, [0, 1, 2]);        // seat 2 declared wrongly and still wins
  assert.ok(r.seized[2]);
  st = make([S(2), S(2), S(2), W(2), W(2), W(2)]);
  r = E.score(st, [1, 1, -1, -1, -1, -1]);
  assert.equal(r.how, 'declarations'); assert.equal(r.winSide, -1);
  st = make([S(3), S(2), S(2), W(2), W(2), W(2)]);
  r = E.score(st, [1, 1, 1, -1, -1, -1]);
  assert.equal(r.how, 'tightness'); assert.equal(r.winSide, 1);
  st = make([S(2), S(2), S(2), W(2), W(2), W(2)]);
  r = E.score(st, [1, 1, 1, -1, -1, -1]);
  assert.equal(r.how, 'draw'); assert.deepEqual(r.winners, []);
});

test('Rust wins alone only when two other flipped players declare wrongly', () => {
  // Seats 1 and 2 were dealt Widdershins, ended Sunwise, and still declare Widdershins.
  let st = make([S(2), S(1), S(1), W(2), W(2)], ['Rust', 'Cog', 'Cog', 'Cog', 'Cog']);
  st.players[1].dealSide = -1; st.players[2].dealSide = -1;
  let r = E.score(st, [1, -1, -1, -1, -1]);
  assert.ok(r.rustWin); assert.deepEqual(r.winners, [0]);
  // A player who never changed side and declares wrongly on purpose does not count.
  st = make([S(2), S(1), S(1), W(2), W(2)], ['Rust', 'Cog', 'Cog', 'Cog', 'Cog']);
  st.players[1].dealSide = -1;
  r = E.score(st, [1, -1, -1, 1, -1]);
  assert.ok(!r.rustWin);
  assert.equal(r.winSide, 1);
  assert.ok(!r.winners.includes(0));             // the Rust holder does not win with its spring's side
});

test('a missing declaration counts as the dealt side', () => {
  const st = make([S(2), S(2), S(2), W(2), W(2)]);
  const r = E.score(st, [null, null, null, null, null]);
  assert.deepEqual(r.decl, [1, 1, 1, -1, -1]);
});

test('random full rounds never leave the track or break invariants', () => {
  for (let k = 0; k < 3000; k++) {
    const n = 5 + (k % 5);
    const st = E.deal(n, Math.random);
    for (let t = 0; t < 3; t++) {
      const acts = st.players.map((_, i) => {
        if (Math.random() < 0.1) return null;
        let tg = Math.floor(Math.random() * n); if (tg === i) tg = (tg + 1) % n;
        return { target: tg, dir: Math.random() < 0.5 ? 1 : -1 };
      });
      const rec = E.resolveTick(st, acts, Math.random);
      st.players.forEach((p) => assert.ok(p.idx >= 0 && p.idx <= 5));
      assert.deepEqual(st.players.map((p) => p.role).sort(), E.SETUPS[n].slice().sort());
      assert.equal(rec.reports.length, n);
    }
    const r = E.score(st, st.players.map(() => (Math.random() < 0.5 ? 1 : -1)));
    assert.ok(['headcount', 'declarations', 'tightness', 'draw', 'rust'].includes(r.how));
    if (r.rustWin) assert.equal(r.winners.length, 1);
  }
});
