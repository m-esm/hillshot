// Hillshot — authoritative WebSocket game server.
// Serves the static client and runs rooms. Physics live in game.js; the server
// owns terrain, turn order, HP truth, and broadcasts resolved shell animations.

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import {
  WORLD, makeTerrain, groundAt, resolveFire, newWind, WEAPONS, WEAPON_ORDER,
} from "./game.js";
import { botName, botSocket, botDecide } from "./bot.js";
import { hashIp, newMatchStats, recordMatch, statsSummary } from "./telemetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 8090;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (url === "/") url = "/index.html";
  if (url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(statsSummary(), null, 2));
  }
  const file = path.join(PUBLIC, path.normalize(url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---- room model ----
const rooms = new Map(); // code -> room
const TANK_COLORS = ["#4cc9f0", "#f72585", "#ffd166", "#06d6a0", "#b5179e", "#fb8500", "#8ac926", "#ff595e"];

function code4() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += A[(Math.random() * A.length) | 0];
  return s;
}

function makeRoom(code) {
  const seed = (Math.random() * 2 ** 31) | 0;
  return {
    code,
    seed,
    terrain: makeTerrain(seed),
    players: [],          // {id, name, ws, teamFFA, color, ready}
    tanks: [],            // {id, x, y, hp, facing, alive}
    started: false,
    turnIdx: 0,
    wind: newWind(),
    order: [],            // player ids in turn order
    hostId: null,
    awaitingResolve: false, // true between a fire and its resolution (turn lock)
    turnTimer: null,        // handle for the per-turn countdown
  };
}

const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 30;  // per-turn time limit before the shot is forfeited

function humanCount(room) {
  return room.players.filter((p) => !p.bot).length;
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// Start the countdown for whoever's turn it is. On expiry the turn is forfeited.
function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.started) return;
  const turnId = room.order[room.turnIdx];
  const p = room.players.find((pp) => pp.id === turnId);
  if (!p || p.bot) return; // bots fire on their own quickly; no forfeit timer
  room.turnTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room || !room.started) return;
    if (room.order[room.turnIdx] !== turnId || room.awaitingResolve) return;
    // forfeit: skip this player's shot
    if (room.stats) room.stats.forfeits++;
    broadcast(room, "forfeit", { id: turnId });
    advanceTurn(room);
  }, TURN_SECONDS * 1000);
}

function send(ws, type, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }));
}
function broadcast(room, type, data) {
  for (const p of room.players) send(p.ws, type, data);
}

function lobbyState(room) {
  return {
    code: room.code,
    started: room.started,
    hostId: room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready, bot: !!p.bot })),
    weapons: WEAPON_ORDER.map((k) => ({ key: k, name: WEAPONS[k].name })),
  };
}

function spawnTanks(room) {
  const n = room.players.length;
  const W = WORLD.W;
  const margin = 90;
  const gap = (W - margin * 2) / Math.max(1, n - 1);
  room.tanks = room.players.map((p, i) => {
    const x = n === 1 ? W / 2 : Math.round(margin + gap * i);
    const y = groundAt(room.terrain, x);
    return { id: p.id, x, y, hp: WORLD.MAX_HP, facing: x < W / 2 ? 1 : -1, name: p.name, color: p.color };
  });
  room.order = room.players.map((p) => p.id);
  room.turnIdx = 0;
}

function gameState(room) {
  return {
    seed: room.seed,
    terrain: Array.from(room.terrain, (v) => Math.round(v)),
    tanks: room.tanks.map((t) => ({ id: t.id, x: Math.round(t.x), y: Math.round(t.y), hp: t.hp, facing: t.facing, name: t.name, color: t.color })),
    turnId: room.order[room.turnIdx],
    wind: room.wind,
    turnSeconds: TURN_SECONDS,
    world: { W: WORLD.W, H: WORLD.H, maxHp: WORLD.MAX_HP },
  };
}

function alivePlayers(room) {
  const aliveIds = new Set(room.tanks.filter((t) => t.hp > 0).map((t) => t.id));
  return room.order.filter((id) => aliveIds.has(id));
}

function advanceTurn(room) {
  clearTurnTimer(room);
  room.awaitingResolve = false;
  const alive = alivePlayers(room);
  if (alive.length <= 1) {
    const winner = alive[0] ? room.tanks.find((t) => t.id === alive[0]) : null;
    room.started = false;
    recordMatch(room, winner);
    broadcast(room, "gameover", { winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : "Nobody" });
    // A bots-only room after everyone left should be torn down, not left spinning.
    if (humanCount(room) === 0) { clearTurnTimer(room); rooms.delete(room.code); }
    return;
  }
  // find next alive player after current
  let idx = room.turnIdx;
  for (let i = 0; i < room.order.length; i++) {
    idx = (idx + 1) % room.order.length;
    const t = room.tanks.find((tt) => tt.id === room.order[idx]);
    if (t && t.hp > 0) break;
  }
  room.turnIdx = idx;
  room.wind = newWind();
  broadcast(room, "turn", { turnId: room.order[room.turnIdx], wind: room.wind });
  startTurnTimer(room);
  maybeBotTurn(room);
}

function startGame(room) {
  room.seed = (Math.random() * 2 ** 31) | 0;
  room.terrain = makeTerrain(room.seed);
  room.started = true;
  room.awaitingResolve = false;
  room.wind = newWind();
  room.stats = newMatchStats(room);
  spawnTanks(room);
  broadcast(room, "start", gameState(room));
  startTurnTimer(room);
  maybeBotTurn(room);
}

wss.on("connection", (ws, req) => {
  ws.id = "p" + Math.random().toString(36).slice(2, 9);
  ws.roomCode = null;
  ws.ipHash = hashIp(req);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;

    if (t === "create") {
      let code; do { code = code4(); } while (rooms.has(code));
      const room = makeRoom(code);
      rooms.set(code, room);
      joinRoom(ws, room, msg.name);
      return;
    }

    if (t === "join") {
      const room = rooms.get((msg.code || "").toUpperCase());
      if (!room) return send(ws, "error", { message: "Room not found" });
      if (room.started) return send(ws, "error", { message: "Game already in progress" });
      if (room.players.length >= 8) return send(ws, "error", { message: "Room is full (8 max)" });
      joinRoom(ws, room, msg.name);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const me = room.players.find((p) => p.id === ws.id);
    if (!me) return;

    if (t === "ready") {
      me.ready = !!msg.ready;
      broadcast(room, "lobby", lobbyState(room));
      return;
    }

    if (t === "addbot") {
      if (ws.id !== room.hostId || room.started) return;
      if (room.players.length >= 8) return send(ws, "error", { message: "Room is full (8 max)" });
      addBot(room);
      broadcast(room, "lobby", lobbyState(room));
      return;
    }

    if (t === "removebot") {
      if (ws.id !== room.hostId || room.started) return;
      // remove the last bot, or a specific one by id
      let idx = -1;
      if (msg.id) idx = room.players.findIndex((p) => p.bot && p.id === msg.id);
      if (idx < 0) { for (let i = room.players.length - 1; i >= 0; i--) if (room.players[i].bot) { idx = i; break; } }
      if (idx >= 0) room.players.splice(idx, 1);
      broadcast(room, "lobby", lobbyState(room));
      return;
    }

    if (t === "start") {
      if (ws.id !== room.hostId) return;
      if (room.players.length < 2) return send(ws, "error", { message: "Need at least 2 players. Add a bot to play solo." });
      startGame(room);
      return;
    }

    if (t === "fire") {
      if (!room.started) return;
      if (room.order[room.turnIdx] !== ws.id) return; // not your turn
      if (room.awaitingResolve) return;               // already fired this turn (double-click / lag)
      room.awaitingResolve = true;
      clearTurnTimer(room);
      doFire(room, ws.id, msg);
      return;
    }

    if (t === "aim") {
      // live aim preview to others (optional flourish)
      if (room.order[room.turnIdx] !== ws.id) return;
      broadcast(room, "aim", { id: ws.id, angle: msg.angle, power: msg.power });
      return;
    }

    if (t === "chat") {
      const text = String(msg.text || "").slice(0, 200);
      if (text) broadcast(room, "chat", { name: me.name, text, color: me.color });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== ws.id);
    const tank = room.tanks.find((tt) => tt.id === ws.id);
    if (tank) tank.hp = 0; // treat leaver as dead
    if (room.hostId === ws.id) room.hostId = room.players.find((p) => !p.bot) ? room.players.find((p) => !p.bot).id : null;
    // no humans left -> drop the room (and any bots) entirely
    if (humanCount(room) === 0) { clearTurnTimer(room); rooms.delete(room.code); return; }
    broadcast(room, "lobby", lobbyState(room));
    if (room.started) {
      // if it was their turn, move on
      if (room.order[room.turnIdx] === ws.id) advanceTurn(room);
      else broadcast(room, "sync", gameState(room));
    }
  });
});

function joinRoom(ws, room, name) {
  ws.roomCode = room.code;
  const color = TANK_COLORS[room.players.length % TANK_COLORS.length];
  const p = { id: ws.id, name: (String(name || "Player").slice(0, 16)) || "Player", ws, color, ready: false, ipHash: ws.ipHash };
  room.players.push(p);
  if (!room.hostId) room.hostId = ws.id;
  send(ws, "joined", { you: ws.id, code: room.code });
  broadcast(room, "lobby", lobbyState(room));
}

// ---- bots ----
function addBot(room) {
  const id = "b" + Math.random().toString(36).slice(2, 9);
  const color = TANK_COLORS[room.players.length % TANK_COLORS.length];
  room.players.push({ id, name: botName(), ws: botSocket(), color, ready: true, bot: true });
}

// Resolve a fire action from any shooter (human or bot).
function doFire(room, shooterId, msg) {
  const shooter = room.tanks.find((tt) => tt.id === shooterId);
  if (!shooter || shooter.hp <= 0) return;
  if (room.stats) {
    room.stats.shots++;
    const sp = room.players.find((p) => p.id === shooterId);
    if (sp && !sp.bot) room.stats.humanShots++;
  }
  const weapon = WEAPON_ORDER.includes(msg.weapon) ? msg.weapon : "shot";
  const angle = Math.max(0, Math.min(180, Number(msg.angle) || 45));
  const power = Math.max(5, Math.min(100, Number(msg.power) || 50));
  shooter.wind = room.wind;
  const result = resolveFire(room.terrain, room.tanks, shooter, weapon, angle, power);
  broadcast(room, "fired", {
    shooterId, weapon, angle, power, wind: room.wind,
    shells: result.shells, damage: result.damage,
    tanks: room.tanks.map((tk) => ({ id: tk.id, x: Math.round(tk.x), y: Math.round(tk.y), hp: tk.hp })),
  });
  const flightMs = Math.min(6000, 600 + result.shells.reduce((a, s) => a + s.path.length, 0) * 4);
  setTimeout(() => { if (rooms.get(room.code) === room && room.started) advanceTurn(room); }, flightMs);
}

// If the current turn belongs to a bot, have it think and fire after a short beat.
function maybeBotTurn(room) {
  if (!room.started) return;
  const turnId = room.order[room.turnIdx];
  const p = room.players.find((pp) => pp.id === turnId);
  if (!p || !p.bot) return;
  const shooter = room.tanks.find((tt) => tt.id === turnId);
  if (!shooter || shooter.hp <= 0) return;
  setTimeout(() => {
    if (rooms.get(room.code) !== room || !room.started) return;
    if (room.order[room.turnIdx] !== turnId) return; // turn moved on
    if (room.awaitingResolve) return;                // already resolving
    room.awaitingResolve = true;
    const decision = botDecide(room, shooter);
    doFire(room, turnId, decision);
  }, 1100 + Math.random() * 700);
}

server.listen(PORT, () => {
  console.log(`Hillshot on :${PORT}`);
});
