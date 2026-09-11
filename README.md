# Hillshot

Online turn-based tank artillery — an original turn-based artillery game you can play together in the browser.
Set angle, power, and account for wind; blow up the other tanks on destructible terrain.

## Play
- Create a room, share the 4-letter code, friends join. Up to 8 players.
- Solo? Add bots from the lobby (up to 7).
- Aim with the sliders or arrow keys; Space/Enter to fire.
- Weapons: Shot, Big Shot, Tri-Shot, Roller, Digger, Air Strike.

## Architecture
- **Server-authoritative.** `server/game.js` owns all physics, terrain, damage, and turn order. No client can desync or cheat.
- **Phaser 3 presentation layer.** `public/game-view.js` renders sprites, particles, explosions, camera shake, and audio by playing back the trajectories the server resolves. `public/app.js` handles networking, lobby, HUD, and controls.
- **Bots** (`server/bot.js`) aim by simulating candidate shots against a clone of the live state with the real physics, then pick the best-scoring solution (with difficulty-scaled aim noise).

## Run locally
```bash
npm install
PORT=8090 npm start
# open http://localhost:8090
```

## Deploy (Docker)
```bash
docker compose up -d --build
```
Container `shellshock` listens on `:8090`, joins the external `deploy_default` network.
Front it with Caddy: `shellshock.<host>` → `shellshock:8090` (WebSocket upgrade passes through natively).

## Assets
Tank sprites, explosion frames, and audio are Kenney CC0 (public domain). See `public/assets/*/KENNEY-LICENSE.txt`.
Phaser is MIT (vendored at `public/vendor/phaser.min.js`).
