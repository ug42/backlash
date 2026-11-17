# Backlash

A seven-minute social deduction game for 5 to 9 players, played in the browser.
Twist a key, get twisted back, then guess which way you're wound.

This repository holds the whole game: a Node server that runs the rules and the
rooms, and a browser client with no build step. Players talk in person or on a
voice call; the game itself has no chat.

## Run it locally

Requires Node 20 or newer.

    npm install
    npm start            # http://localhost:3000
    npm run dev          # same, with short timers for trying things out
    npm test             # rules tests plus a full round over WebSockets

Open the page, create a room, and share the four-letter code or the link. The
host can add bots to fill seats, so one person can try a round alone.

## How it is built

| Path | What it does |
| --- | --- |
| `src/engine.js` | The rules as pure functions: deal, resolve a tick, score. No I/O |
| `src/room.js` | One room: lobby, phase timers, bots, and the private view each player is sent |
| `src/server.js` | Static files, `/healthz`, and the `/ws` WebSocket endpoint |
| `public/` | The client: `index.html`, `app.js`, `style.css` |
| `test/` | Unit tests for every rule and an end-to-end round |

The server is authoritative. Each player's socket receives only their own
faceplate, dial and reports; no spring position leaves the server before the
reveal. A test checks this on every message of a full round.

Round flow: Lobby, Deal (30 s), three Ticks (1:50 each), Declaration (20 s),
Reveal. A phase ends early when every connected human has locked in. A player
who disconnects idles and can rejoin with the token kept in their browser.

All state is in memory. A restart or redeploy ends open rooms.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on |
| `DEAL_MS`, `TICK_MS`, `DECLARE_MS` | 30000, 110000, 20000 | Phase lengths |
| `FAST` | unset | Set to `1` for 4 s / 8 s / 5 s phases |
| `MAX_ROOMS` | 200 | Refuse new rooms beyond this |

## Deploy for free on Render

Render's free web service runs a normal Node process, needs no payment card,
and supports WebSockets. This repo includes a `render.yaml` blueprint.

1. Push this folder to a GitHub repository.
2. In Render choose New, then Blueprint, and pick the repository.
3. Accept the plan it shows (one free web service) and deploy.
4. Open the `onrender.com` URL it gives you.

What the free plan means for this game:

- The service sleeps after 15 minutes with no HTTP request and no WebSocket
  message. The client sends a small ping every 25 seconds, so it stays awake
  while anyone has the page open.
- The first visit after a sleep takes up to a minute to load.
- A workspace gets 750 free instance hours a month. Sleeping uses none.
- One instance only, which is what an in-memory room server needs.

Check Render's free-plan page before relying on this; free tiers change.

### Other hosts

The `Dockerfile` runs anywhere that accepts a container and passes WebSockets
through: Google Cloud Run (free allowance, card required, set the request
timeout to 60 minutes and max instances to 1), Koyeb (free instance, card
required), or any small VM.

Cloudflare Workers with Durable Objects is free and never sleeps, but it is a
different runtime. `engine.js` would move over unchanged; `room.js` and
`server.js` would need rewriting as a Durable Object per room.

## Rules implemented

The current rules from the design doc: recoil, jams, the hands rule (two hands
from the pulling side, or one on a key at tightness 1), the Overwind, loose
faceplates that jump after ticks 1 and 2, the Listener, Cracked Listener, Echo,
Surveyor, Watchmaker and Balance Wheel, the Decoy's reversing sham, Rust as a
third faction, the Mainspring and loose keys at odd counts, and scoring by
headcount, then correct declarations, then tightness.

Randomness, each switchable by the host in the lobby:

- **Random events.** Three are drawn per round, one per tick, and announced when
  the tick begins: Slipped Gear, Stiff Springs, Greased Springs, Scramble, Fog,
  Stuck Dial, or Calm.
- **Random faceplates.** Each round draws its set from the full list, always with
  one Rust, the Mainspring at odd counts and at least two information plates.
- **Learning round.** Everyone is a plain Cog and there are no events.

## The reveal

After the declarations every client plays an animated replay in five steps: the
deal, each tick, and the result. Each player has a lane; a marker slides along
the six-step track as their spring moves, a dotted ring marks where it was
dealt, and a chip flashes when their faceplate changes. The replay can be
paused, stepped, skipped or watched again, and it respects the browser's
reduced-motion setting.

`npm run sim` plays 20,000 bot rounds per setting and prints balance figures.

## Known limits

- Bots twist a random player, recruit when wound tightly and brace when loose,
  and always declare the side they were dealt. They do not talk.
- No accounts, no persistence, no spectators. A player who opens the room link
  mid-round cannot join until the next deal.
- One server process holds every room, so it does not scale past one instance.
