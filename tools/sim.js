'use strict';
/* Quick balance check: simple bots (recruit when wound to 2+, brace at 1) over many rounds. */
const E = require('../src/engine');
function run(opts, games = 20000) {
  const out = { larger: 0, odd: 0, draws: 0, cross: 0, plateChanged: 0, seats: 0, zero: 0, how: {} };
  for (let g = 0; g < games; g++) {
    const n = 5 + (g % 5);
    const st = E.deal(n, Math.random, opts);
    let cross = 0;
    for (let t = 0; t < 3; t++) {
      const acts = st.players.map((p, i) => {
        let tg = Math.floor(Math.random() * (n - 1)); if (tg >= i) tg++;
        return { target: tg, dir: p.shown >= 2 ? p.dealSide : -p.dealSide };
      });
      cross += E.resolveTick(st, acts, Math.random).chime;
    }
    const r = E.score(st, st.players.map((p) => E.side(p.idx)));   // everyone declares correctly: isolates the springs
    out.cross += cross; if (!cross) out.zero++;
    out.how[r.how] = (out.how[r.how] || 0) + 1;
    if (r.how === 'draw') out.draws++;
    if (n % 2) { out.odd++; if (r.winSide === st.larger) out.larger++; }
    st.players.forEach((p) => { out.seats++; if (p.role !== p.dealRole) out.plateChanged++; });
  }
  return `larger side won ${(100 * out.larger / out.odd).toFixed(1)}% | draws ${(100 * out.draws / games).toFixed(1)}% | crossings/round ${(out.cross / games).toFixed(2)} | rounds with no crossing ${(100 * out.zero / games).toFixed(1)}% | players ending on a new faceplate ${(100 * out.plateChanged / out.seats).toFixed(0)}%`;
}
console.log('fixed plates, no events :', run({}));
console.log('random plates only      :', run({ variety: true }));
console.log('events only             :', run({ events: true }));
console.log('random plates + events  :', run({ variety: true, events: true }));
