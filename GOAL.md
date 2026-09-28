# GOAL

Two players finish a full match online with bot option, on a single domain, with revised controls and tank assets across every step of the game

Play: https://hillshot.46.225.91.43.sslip.io (old `shellshock.` address redirects there).

Not a storefront, not an HTML5 portal listing, not a Steam page.

The number below counts finished human-vs-human matches. It does not count tank sprites on lobby/room/HUD/gameover — those are in `public/index.html`, `public/app.js`, and `public/game-view.js`.

## Numbers that prove it

- completed human-vs-human matches: `python3 scripts/measure_hvh.py` - today: 2; target: 1

Source: `server/telemetry.js`, `scripts/measure_hvh.py`, and `GET /stats`.
