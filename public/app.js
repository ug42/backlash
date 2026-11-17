'use strict';
/* Backlash browser client. No build step: one WebSocket, one render function. */
(() => {
  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  const SIDE = { 1: 'Sunwise', '-1': 'Widdershins' };
  const ARROW = { 1: '↻', '-1': '↺' };
  const KEY = 'backlash.session';

  let ws = null;
  let state = null;          // last server view
  let clock = 0;             // server time minus local time
  let sel = { target: null, dir: null };
  let pending = null;        // message to send once the socket opens
  let lastPhaseKey = '';
  let retry = 0;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
    name() { try { return localStorage.getItem('backlash.name') || ''; } catch { return ''; } },
    setName(n) { try { localStorage.setItem('backlash.name', n); } catch { /* ignore */ } },
  };

  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 4000);
  }

  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      retry = 0; $('#banner').hidden = true;
      const s = store.get();
      if (pending) { send(pending); pending = null; }
      else if (s) send({ t: 'rejoin', code: s.code, token: s.token });
      else render();
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'joined') store.set({ code: m.code, token: m.token, id: m.id });
      else if (m.t === 'state') { state = m; clock = m.now - Date.now(); render(); }
      else if (m.t === 'gone') { store.clear(); state = null; render(); }
      else if (m.t === 'error') toast(m.msg);
    };
    ws.onclose = () => {
      const b = $('#banner');
      b.textContent = 'Connection lost. Reconnecting…'; b.hidden = false;
      setTimeout(connect, Math.min(8000, 800 * 2 ** retry++));
    };
  }
  // Keeps the connection (and a sleeping free host) awake.
  setInterval(() => send({ t: 'ping' }), 25000);

  // ---- timer --------------------------------------------------------------
  setInterval(() => {
    const el = $('#timer');
    if (!state || !state.deadline) { el.hidden = true; return; }
    const left = Math.max(0, Math.ceil((state.deadline - (Date.now() + clock)) / 1000));
    el.hidden = false;
    el.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    el.classList.toggle('low', left <= 10);
  }, 250);

  // ---- views --------------------------------------------------------------
  const me = () => state && state.you;
  const isHost = () => state && state.you && state.hostId === state.you.id;
  const nameOf = (id) => { const p = state.players.find((q) => q.id === id); return p ? p.name : '?'; };

  function home() {
    const code = new URLSearchParams(location.search).get('room') || '';
    return `
      <section class="card">
        <h1>Backlash</h1>
        <p class="muted">Twist a key, get twisted back, then guess which way you're wound. 5 to 9 players, 7 minutes a round. Talk out loud or on a call while you play.</p>
        <label for="name">Your name</label>
        <input id="name" type="text" maxlength="16" autocomplete="nickname" value="${esc(store.name())}" placeholder="Name">
      </section>
      <section class="card">
        <h2>Join a room</h2>
        <div class="row">
          <div class="grow"><label for="code">Room code</label><input id="code" class="code" type="text" maxlength="4" value="${esc(code)}" placeholder="ABCD" autocapitalize="characters"></div>
          <button class="primary" data-act="join">Join</button>
        </div>
      </section>
      <section class="card">
        <h2>Start a new room</h2>
        <p class="muted small">You get a four-letter code to share. You can fill empty seats with bots.</p>
        <button class="wide" data-act="create">Create room</button>
      </section>`;
  }

  function people(showReady) {
    return `<ul class="people">${state.players.map((p) => `
      <li class="${p.connected ? '' : 'off'}">
        <span class="dot ${showReady && p.ready ? 'on' : ''}" title="${showReady ? (p.ready ? 'Locked in' : 'Still choosing') : ''}"></span>
        <span class="grow">${esc(p.name)}${p.id === me().id ? ' <span class="muted">(you)</span>' : ''}</span>
        ${p.id === state.hostId ? '<span class="tag">host</span>' : ''}
        ${p.connected ? '' : '<span class="tag">away</span>'}
        <span class="tag" title="Rounds won">${p.score} won</span>
      </li>`).join('')}</ul>`;
  }

  function lobby() {
    const n = state.players.length;
    const ok = n >= state.min && n <= state.max;
    const link = location.origin + '/?room=' + state.code;
    return `
      <section class="card">
        <h2>Room ${esc(state.code)}</h2>
        <p class="muted small">Share this link: <a href="${esc(link)}" style="color:var(--brass)">${esc(link)}</a></p>
        ${people(false)}
        <p class="muted small" style="margin-top:10px">${n} of ${state.min} to ${state.max} players.</p>
      </section>
      ${isHost() ? `
      <section class="card">
        <div class="row">
          <button data-act="addBot" ${n >= state.max ? 'disabled' : ''}>Add a bot</button>
          <button data-act="removeBot" class="ghost" ${state.players.some((p) => p.isBot) ? '' : 'disabled'}>Remove a bot</button>
        </div>
        <p class="row small" style="margin-top:12px"><input id="learning" type="checkbox" ${state.learning ? 'checked' : ''}> <label for="learning" style="margin:0;font-size:1rem;color:var(--ink)">Learning round: everyone is a plain Cog</label></p>
        <button class="primary wide" data-act="start" ${ok ? '' : 'disabled'}>${ok ? 'Deal the round' : `Need ${state.min} players`}</button>
      </section>` : '<section class="card tight muted">Waiting for the host to deal.</section>'}`;
  }

  function dial(g, withSide) {
    const pips = [1, 2, 3].map((i) => `<span class="pip ${i <= g.tightness ? 'on' : ''}"></span>`).join('');
    const sideTxt = withSide && g.dealSide ? `<div class="${g.dealSide > 0 ? 'side-s' : 'side-w'}"><strong>${ARROW[g.dealSide]} ${SIDE[g.dealSide]}</strong></div>` : '<div class="muted">Direction hidden</div>';
    return `<div class="dial">
      <div class="key" aria-hidden="true">${withSide && g.dealSide ? ARROW[g.dealSide] : '?'}</div>
      <div><div class="small muted">Your spring</div>${sideTxt}
        <div>Tightness ${g.tightness} of 3</div><div class="pips" role="img" aria-label="Tightness ${g.tightness} of 3">${pips}</div></div>
    </div>`;
  }

  const myReady = () => { const p = state.players.find((q) => q.id === me().id); return p && p.ready; };

  function dealView() {
    const g = state.game;
    return `
      <section class="card">${dial(g, true)}
        <p class="small muted" style="margin-top:10px">Remember your direction. After the deal the game never shows it again.</p></section>
      <section class="card"><h3>Your faceplate</h3><h2>${esc(g.faceplate)}</h2><p>${esc(g.faceplateText)}</p>
        ${g.history[0].lines.slice(2).map((l) => `<p><strong>${esc(l)}</strong></p>`).join('')}</section>
      <button class="primary wide" data-act="ready" ${myReady() ? 'disabled' : ''}>${myReady() ? 'Waiting for the others…' : 'Got it'}</button>`;
  }

  function history(g) {
    const items = g.history.slice().reverse().map((h) => `<li><div class="t">${h.tick === 0 ? 'Deal' : 'Tick ' + h.tick}</div>${h.lines.map((l) => `<div>${esc(l)}</div>`).join('')}</li>`).join('');
    return `<section class="card"><h3>Your private log</h3><ul class="log">${items}</ul></section>`;
  }

  function chimes(g) {
    if (!g.table.length) return '';
    return `<section class="card tight"><h3>What the whole table heard</h3><div class="chimes">${g.table.map((t) => `
      <span class="chip">Tick ${t.tick}: ${t.chime} ${t.chime === 1 ? 'key' : 'keys'} crossed</span>
      ${t.overwind ? `<span class="chip warn">Tick ${t.tick}: Overwind, a spring snapped</span>` : ''}
      ${t.idle.length ? `<span class="chip">Tick ${t.tick} idle: ${esc(t.idle.join(', '))}</span>` : ''}`).join('')}</div></section>`;
  }

  function tickView() {
    const g = state.game;
    if (g.choice && sel.target === null) sel = { target: g.choice.target, dir: g.choice.dir };
    const others = state.players.filter((p) => p.id !== me().id && p.seated);
    const locked = myReady();
    let preview = 'Pick a player, then a direction.';
    if (sel.target && sel.dir) {
      preview = `<strong>${esc(nameOf(sel.target))}</strong> turns ${ARROW[sel.dir]} ${SIDE[sel.dir]} one step. You recoil ${ARROW[-sel.dir]} ${SIDE[-sel.dir]} one step.`;
    } else if (sel.target) preview = `Now choose which way to twist <strong>${esc(nameOf(sel.target))}</strong>.`;
    return `
      <section class="card tight row"><div class="grow"><h2 style="margin:0">Tick ${g.tick} of ${g.ticks}</h2><div class="small muted">Talk, then lock in one twist.</div></div>
        <div class="small muted">Faceplate: <strong style="color:var(--ink)">${esc(g.faceplate)}</strong></div></section>
      <section class="card">${dial(g, false)}</section>
      ${chimes(g)}
      <section class="card">
        <h3>Twist whom?</h3>
        <div class="targets">${others.map((p) => `<button data-act="target" data-id="${p.id}" aria-pressed="${sel.target === p.id}" ${locked ? 'disabled' : ''}>
          <span>${esc(p.name)}</span><span class="dot ${p.ready ? 'on' : ''}" title="${p.ready ? 'Locked in' : 'Still choosing'}"></span></button>`).join('')}</div>
        <h3 style="margin-top:14px">Which way?</h3>
        <div class="dirs">
          <button class="s" data-act="dir" data-dir="1" aria-pressed="${sel.dir === 1}" ${locked ? 'disabled' : ''}><span class="arrow">↻</span>Sunwise</button>
          <button class="w" data-act="dir" data-dir="-1" aria-pressed="${sel.dir === -1}" ${locked ? 'disabled' : ''}><span class="arrow">↺</span>Widdershins</button>
        </div>
        <p class="preview" style="margin-top:12px">${preview}</p>
        <button class="primary wide" data-act="ready" ${locked || !(sel.target && sel.dir) ? 'disabled' : ''}>${locked ? 'Locked in. Waiting for the others…' : 'Lock in'}</button>
        <p class="small muted" style="margin:8px 0 0">If the timer runs out before you lock in, your last choice is used. No choice means you idle.</p>
      </section>
      ${history(g)}`;
  }

  function declareView() {
    const g = state.game;
    return `
      <section class="card"><h2>Which way are you wound?</h2>
        <p class="muted">Declare in silence. A wrong call never costs your side a key, but it can lose a tie, and it feeds Rust if you were flipped.</p>
        <div class="declare">
          <button data-act="declare" data-side="1" aria-pressed="${g.declared === 1}" ${g.declared ? 'disabled' : ''}><span class="arrow">↻</span>Sunwise</button>
          <button data-act="declare" data-side="-1" aria-pressed="${g.declared === -1}" ${g.declared ? 'disabled' : ''} style="border-style:dashed"><span class="arrow">↺</span>Widdershins</button>
        </div>
        ${g.declared ? `<p style="margin-top:12px">You declared <strong>${SIDE[g.declared]}</strong>. Waiting for the others…</p>` : ''}
      </section>
      <section class="card">${dial(g, false)}</section>
      ${chimes(g)}${history(g)}`;
  }

  function track(dealIdx, finalIdx) {
    const cell = (i) => `<span class="cell ${i === finalIdx ? 'final' : ''} ${i === dealIdx ? 'deal' : ''}"></span>`;
    return `<span class="track" role="img" aria-label="Dealt ${pos(dealIdx)}, finished ${pos(finalIdx)}">${[0, 1, 2].map(cell).join('')}<span class="mid"></span>${[3, 4, 5].map(cell).join('')}</span>`;
  }
  const pos = (i) => (i >= 3 ? '↻' + (i - 2) : '↺' + (3 - i));

  function revealView() {
    const r = state.reveal;
    let head; let sub;
    if (r.rustWin) { head = 'Rust wins'; sub = `${r.flippedAndWrong} flipped players declared the wrong side. The clock seizes.`; }
    else if (!r.winSide) { head = 'Draw'; sub = 'Level on headcount, declarations and tightness.'; }
    else {
      head = `${ARROW[r.winSide]} ${SIDE[r.winSide]} wins`;
      sub = `${r.count.sunwise} Sunwise to ${r.count.widdershins} Widdershins` + (r.how === 'headcount' ? '.' : `, settled by ${r.how === 'declarations' ? 'correct declarations' : 'total tightness'}.`);
    }
    const mine = r.players.find((p) => p.id === me().id);
    return `
      <section class="card result"><h1>${head}</h1><p>${esc(sub)}</p>
        ${mine ? `<p class="${mine.won ? 'win' : 'lose'}">${mine.won ? 'You won this round.' : 'You did not win this round.'}${mine.seized ? ' You declared the wrong side.' : ''}</p>` : ''}</section>
      <section class="card"><h3>Every spring</h3><div class="scroll"><table>
        <tr><th>Player</th><th>Track</th><th>Dealt</th><th>Finished</th><th>Declared</th><th>Faceplate</th><th></th></tr>
        ${r.players.map((p) => `<tr>
          <td>${esc(p.name)}${p.loose ? ' <span class="muted small">(loose key)</span>' : ''}</td>
          <td>${track(p.dealIdx, p.finalIdx)}</td><td>${pos(p.dealIdx)}</td><td>${pos(p.finalIdx)}</td>
          <td>${ARROW[p.declared]}${p.seized ? ' <span class="jam">wrong</span>' : ''}</td>
          <td class="small">${esc(p.dealPlate)}${p.dealPlate !== p.finalPlate ? ' → ' + esc(p.finalPlate) : ''}</td>
          <td class="${p.won ? 'win' : 'lose'}">${p.won ? 'Won' : ''}</td></tr>`).join('')}
      </table></div><p class="small muted" style="margin-top:8px">Outlined cell: where the spring was dealt. Filled cell: where it finished. The bar is the midline, Widdershins on the left.</p></section>
      <section class="card"><h3>What actually happened</h3>
        ${r.ticks.map((t) => `<details ${t.tick === 1 ? 'open' : ''}><summary>Tick ${t.tick}: ${t.chime} ${t.chime === 1 ? 'key' : 'keys'} crossed${t.snap ? ', Overwind' : ''}</summary>
          <ul class="twists">
            ${t.twists.map((w) => `<li>${esc(w.from)} twisted ${esc(w.target)} ${ARROW[w.dir]}${w.jammed ? ' <span class="jam">(jammed)</span>' : ''}</li>`).join('')}
            ${t.idle.length ? `<li class="muted">Idle: ${esc(t.idle.join(', '))}</li>` : ''}
            ${t.reversal ? `<li>${esc(t.reversal.actor)}'s Decoy sham on ${esc(t.reversal.target)} reversed</li>` : ''}
            ${t.snap ? `<li class="jam">Overwind: ${esc(t.snap)}'s spring snapped to the other side</li>` : ''}
            ${t.frozen ? `<li>Rust froze ${esc(t.frozen)}'s dial</li>` : ''}
            ${t.hops.map((h) => `<li class="muted">${esc(h.plate)} jumped from ${esc(h.from)} to ${esc(h.to)}</li>`).join('')}
            <li class="muted">After the tick: ${r.players.map((p, i) => esc(p.name) + ' ' + pos(t.positions[i])).join(', ')}</li>
          </ul></details>`).join('')}
      </section>
      <section class="card"><h3>Rounds won</h3>${people(false)}</section>
      ${isHost() ? '<button class="primary wide" data-act="lobby">Back to the lobby</button>' : '<section class="card tight muted">Waiting for the host to start the next round.</section>'}`;
  }

  function render() {
    const room = $('#room');
    if (!state) { room.hidden = true; app.innerHTML = home(); return; }
    room.hidden = false; room.textContent = state.code;
    const key = state.phase + ':' + (state.game ? state.game.tick : 0);
    if (key !== lastPhaseKey) { sel = { target: null, dir: null }; lastPhaseKey = key; window.scrollTo(0, 0); }
    const focusId = document.activeElement && document.activeElement.id;
    if (!state.game && state.phase !== 'LOBBY') {
      app.innerHTML = '<section class="card">A round is in progress. You will join at the next deal.</section>' + `<section class="card">${people(false)}</section>`;
    } else {
      app.innerHTML = { LOBBY: lobby, DEAL: dealView, TICK: tickView, DECLARE: declareView, REVEAL: revealView }[state.phase]();
    }
    if (focusId && $('#' + focusId)) $('#' + focusId).focus();
  }

  // ---- input --------------------------------------------------------------
  function enter(kind) {
    const name = ($('#name').value || '').trim();
    if (!name) { toast('Enter a name first.'); return; }
    store.setName(name);
    const msg = kind === 'create' ? { t: 'create', name } : { t: 'join', name, code: ($('#code').value || '').trim().toUpperCase() };
    if (kind === 'join' && msg.code.length !== 4) { toast('Room codes are four letters.'); return; }
    if (ws && ws.readyState === 1) send(msg); else pending = msg;
  }

  app.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'create' || act === 'join') return enter(act);
    if (act === 'addBot' || act === 'removeBot' || act === 'lobby' || act === 'ready') return send({ t: act });
    if (act === 'start') return send({ t: 'start', learning: !!($('#learning') && $('#learning').checked) });
    if (act === 'declare') return send({ t: 'declare', side: Number(b.dataset.side) });
    if (act === 'target') sel.target = b.dataset.id;
    if (act === 'dir') sel.dir = Number(b.dataset.dir);
    if (sel.target && sel.dir) send({ t: 'twist', target: sel.target, dir: sel.dir });
    render();
  });
  app.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.id === 'code') enter('join');
  });

  connect();
  render();
})();
