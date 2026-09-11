// Hillshot client. Networking + lobby + HUD + controls.
// All rendering/animation/audio is delegated to GameView (Phaser, game-view.js).
"use strict";

/* ---------------- net ---------------- */
const WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
let ws, YOU = null, ROOM = null, HOST = null;
let state = null;          // { seed, terrain[], tanks[], turnId, wind, world }
let weapons = [];
let flying = false;        // true while a shot is being animated

// weapon accent colors (match server game.js WEAPONS) for aim preview + trails
const WEAPON_COLOR = {
  shot: "#ffd166", bigshot: "#f4a261", triple: "#8ecae6",
  roller: "#a3e635", digger: "#c084fc", airstrike: "#ef476f",
};

// Messages clicked before the socket finishes connecting used to be dropped on
// the floor, so "Create room" did nothing on a slow/TLS connection. Queue them.
let pending = [];
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    setNetState(true);
    const q = pending; pending = [];
    for (const m of q) ws.send(JSON.stringify(m));
  };
  ws.onclose = () => { setNetState(false); setTimeout(connect, 1500); };
  ws.onerror = () => setNetState(false);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
function sendMsg(type, data = {}) {
  const m = { type, ...data };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  else pending.push(m);            // flushed on open
}
function setNetState(up) {
  const el = document.getElementById("netState");
  if (el) { el.textContent = up ? "" : "Reconnecting\u2026"; el.classList.toggle("hidden", up); }
  // Lobby buttons stay disabled until the socket is actually usable, so a click
  // on a slow connection can never look accepted while going nowhere.
  for (const id of ["createBtn", "joinBtn"]) {
    const b = document.getElementById(id);
    if (b) b.disabled = !up;
  }
}

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const screens = { lobby: $("lobby"), room: $("room"), game: $("game") };
function show(name) { for (const k in screens) screens[k].classList.toggle("hidden", k !== name); }

$("createBtn").onclick = () => sendMsg("create", { name: nameVal() });
$("joinBtn").onclick = () => {
  const code = $("joinCode").value.trim().toUpperCase();
  if (code.length !== 4) return err("Enter a 4-letter room code.");
  sendMsg("join", { code, name: nameVal() });
};
$("joinCode").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });
$("startBtn").onclick = () => sendMsg("start");
$("addBotBtn").onclick = () => sendMsg("addbot");
$("removeBotBtn").onclick = () => sendMsg("removebot");
$("leaveBtn").onclick = () => location.reload();
function nameVal() { return ($("name").value.trim() || "Player").slice(0, 16); }
function err(m) { $("lobbyErr").textContent = m; }

// boot Phaser once, in the background, so the scene is ready by game start
GameView.boot();

/* ---------------- message routing ---------------- */
function handle(m) {
  switch (m.type) {
    case "joined": YOU = m.you; ROOM = m.code; break;
    case "error": err(m.message); break;
    case "lobby": renderRoom(m); break;
    case "start": beginGame(m); break;
    case "sync": Object.assign(state, m); GameView.applyTankState(m.tanks); syncHud(); break;
    case "turn": onTurn(m); break;
    case "fired": onFired(m); break;
    case "forfeit": onForfeit(m); break;
    case "gameover": onGameOver(m); break;
    case "chat": onChat(m); break;
  }
}

/* ---------------- lobby / room ---------------- */
function renderRoom(m) {
  HOST = m.hostId;
  weapons = m.weapons || weapons;
  if (m.started) return;
  show("room");
  $("roomCode").textContent = m.code;
  const ul = $("playerList"); ul.innerHTML = "";
  for (const p of m.players) {
    const li = document.createElement("li");
    if (p.id === YOU) li.classList.add("you");
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>
      <span>${esc(p.name)}${p.id === YOU ? " (you)" : ""}</span>`;
    const b = document.createElement("span");
    if (p.id === m.hostId) { b.className = "badge host"; b.textContent = "HOST"; }
    else if (p.bot) { b.className = "badge bot"; b.textContent = "BOT"; }
    else { b.className = "badge"; b.textContent = "in lobby"; }
    li.appendChild(b);
    ul.appendChild(li);
  }
  const isHost = YOU === m.hostId;
  const botCount = m.players.filter((p) => p.bot).length;
  const full = m.players.length >= 8;
  $("startBtn").classList.toggle("hidden", !isHost);
  $("addBotBtn").classList.toggle("hidden", !isHost);
  $("addBotBtn").disabled = full;
  $("removeBotBtn").classList.toggle("hidden", !isHost || botCount === 0);
  $("waitHint").classList.toggle("hidden", isHost);
  // fill weapon select
  const sel = $("weapon"); sel.innerHTML = "";
  weapons.forEach((w, i) => { const o = document.createElement("option"); o.value = w.key; o.textContent = (i < 9 ? (i + 1) + " \u00b7 " : "") + w.name; sel.appendChild(o); });
}
function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

/* ---------------- game start ---------------- */
function beginGame(m) {
  state = m;
  if (m.turnSeconds) TURN_SECONDS = m.turnSeconds;
  show("game");
  GameView.ready(() => {
    GameView.start(state);
    GameView.showAimFor(state.turnId, myTurn());
    syncAim();
    syncHud();
    startCountdown();
  });
}

/* ---------------- controls ---------------- */
const angleEl = $("angle"), powerEl = $("power"), fireBtn = $("fireBtn"), weaponEl = $("weapon");
function curColor() { return WEAPON_COLOR[weaponEl.value] || "#ffd166"; }
function syncAim() { GameView.setAim(+angleEl.value, +powerEl.value, curColor()); }
angleEl.oninput = () => { $("angleVal").textContent = angleEl.value + "\u00b0"; syncAim(); };
powerEl.oninput = () => { $("powerVal").textContent = powerEl.value; syncAim(); };
weaponEl.onchange = () => syncAim();

// Fine-tune nudge buttons with press-and-hold repeat.
function nudge(target, delta) {
  const el = target === "angle" ? angleEl : powerEl;
  const min = +el.min, max = +el.max;
  el.value = Math.max(min, Math.min(max, +el.value + delta));
  el.oninput();
}
document.querySelectorAll(".nudge").forEach((b) => {
  let hold = null, rep = null;
  const start = (e) => {
    e.preventDefault();
    if (!myTurn() || flying) return;
    const t = b.dataset.t, d = +b.dataset.d;
    nudge(t, d);
    hold = setTimeout(() => { rep = setInterval(() => nudge(t, d), 60); }, 350);
  };
  const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = null; };
  b.addEventListener("pointerdown", start);
  b.addEventListener("pointerup", stop);
  b.addEventListener("pointerleave", stop);
  b.addEventListener("pointercancel", stop);
});

// Drag-to-aim on the canvas updates the sliders (only affects the local player's turn).
GameView.onAimDrag((angle, power) => {
  if (!myTurn() || flying) return;
  angleEl.value = Math.max(0, Math.min(180, angle));
  // power === null means point-to-aim: angle only, keep the power the player set
  if (power !== null && power !== undefined) powerEl.value = Math.max(5, Math.min(100, power));
  $("angleVal").textContent = angleEl.value + "\u00b0";
  $("powerVal").textContent = powerEl.value;
  syncAim();
});

// Mouse wheel over the field trims power.
GameView.onPowerNudge((d) => {
  if (!myTurn() || flying) return;
  powerEl.value = Math.max(5, Math.min(100, +powerEl.value + d));
  $("powerVal").textContent = powerEl.value;
  syncAim();
});
fireBtn.onclick = () => {
  if (flying || !myTurn()) return;
  flying = true; fireBtn.disabled = true; fireBtn.textContent = "\u2026";
  stopCountdown();
  sendMsg("fire", { weapon: weaponEl.value, angle: +angleEl.value, power: +powerEl.value });
};
// Keyboard: A/D or Left/Right = angle, W/S or Up/Down = power, Shift = coarse (x5),
// 1-6 = weapon slot, Space/Enter = fire.
document.addEventListener("keydown", (e) => {
  if (screens.game.classList.contains("hidden")) return;
  if (document.activeElement === $("chatIn")) return;
  const k = e.key.toLowerCase();
  const step = e.shiftKey ? 5 : 1;
  const setA = (d) => { angleEl.value = Math.max(0, Math.min(180, +angleEl.value + d)); angleEl.oninput(); };
  const setP = (d) => { powerEl.value = Math.max(5, Math.min(100, +powerEl.value + d)); powerEl.oninput(); };
  if (k === "arrowleft" || k === "a") { e.preventDefault(); setA(+step); return; }
  if (k === "arrowright" || k === "d") { e.preventDefault(); setA(-step); return; }
  if (k === "arrowup" || k === "w") { e.preventDefault(); setP(+step); return; }
  if (k === "arrowdown" || k === "s") { e.preventDefault(); setP(-step); return; }
  if (k >= "1" && k <= "9") {
    const i = +k - 1;
    if (weaponEl.options[i]) { weaponEl.selectedIndex = i; weaponEl.onchange && weaponEl.onchange(); syncAim(); }
    return;
  }
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!fireBtn.disabled) fireBtn.click(); }
});

// mute toggle
const muteBtn = $("muteBtn");
if (muteBtn) muteBtn.onclick = () => { GameView.mute(!GameView.isMuted()); muteBtn.textContent = GameView.isMuted() ? "\ud83d\udd07" : "\ud83d\udd0a"; };

$("chatIn").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.value.trim()) { sendMsg("chat", { text: e.target.value.trim() }); e.target.value = ""; }
});
function onChat(m) {
  const log = $("chatLog");
  const d = document.createElement("div");
  d.innerHTML = `<b style="color:${m.color}">${esc(m.name)}:</b> ${esc(m.text)}`;
  log.appendChild(d);
  while (log.children.length > 6) log.removeChild(log.firstChild);
}

function myTurn() { return state && state.turnId === YOU; }
// read-only handles for automated QA drivers
Object.defineProperty(window, "__you", { get: () => YOU });
Object.defineProperty(window, "__state", { get: () => state });

/* ---------------- turn / hud ---------------- */
let TURN_SECONDS = 30;
let turnDeadline = 0, turnTicker = null;
function startCountdown() {
  turnDeadline = Date.now() + TURN_SECONDS * 1000;
  if (turnTicker) clearInterval(turnTicker);
  turnTicker = setInterval(updateCountdown, 250);
  updateCountdown();
}
function stopCountdown() {
  if (turnTicker) { clearInterval(turnTicker); turnTicker = null; }
  const el = $("turnTimer"); if (el) el.textContent = "";
}
function updateCountdown() {
  const el = $("turnTimer"); if (!el) return;
  const left = Math.max(0, Math.ceil((turnDeadline - Date.now()) / 1000));
  el.textContent = left + "s";
  el.classList.toggle("low", left <= 8);
  if (left <= 0) stopCountdown();
}

function onForfeit(m) {
  stopCountdown();
  const t = state.tanks.find((x) => x.id === m.id);
  if (t) GameView.flash(t.name + " ran out of time");
}

function onTurn(m) {
  state.turnId = m.turnId; state.wind = m.wind;
  GameView.setWind(m.wind);
  GameView.showAimFor(m.turnId, myTurn());
  syncAim();
  syncHud();
  startCountdown();
}

function syncHud() {
  const w = state.wind;
  $("windVal").textContent = (w > 0 ? "+" : "") + w;
  const arr = $("windArrow"); arr.textContent = w === 0 ? "\u2022" : (w > 0 ? "\u2192" : "\u2190");
  arr.style.transform = `scaleX(${Math.max(0.5, Math.min(2, Math.abs(w) / 8 + 0.6))})`;
  arr.style.color = Math.abs(w) > 9 ? "#ef476f" : "#ffd166";
  const cur = state.tanks.find((t) => t.id === state.turnId);
  $("turnName").textContent = cur ? cur.name + (state.turnId === YOU ? " (you)" : "") : "\u2014";
  $("turnName").style.color = cur ? cur.color : "#fff";
  // players hud
  const hud = $("playersHud"); hud.innerHTML = "";
  for (const t of state.tanks) {
    const el = document.createElement("div");
    el.className = "php" + (t.id === state.turnId ? " turn" : "") + (t.hp <= 0 ? " dead" : "");
    el.innerHTML = `<span class="dot" style="background:${t.color};width:10px;height:10px"></span>
      <span>${esc(t.name)}</span>
      <span class="hpbar"><span class="hpfill" style="width:${Math.max(0, t.hp)}%;background:${hpColor(t.hp)}"></span></span>`;
    hud.appendChild(el);
  }
  const on = myTurn() && !flying;
  fireBtn.disabled = !on;
  fireBtn.textContent = flying ? "\u2026" : (myTurn() ? "FIRE" : "WAIT");
}
function hpColor(hp) { return hp > 55 ? "#06d6a0" : hp > 25 ? "#ffd166" : "#ef476f"; }

/* ---------------- fire resolution ---------------- */
function onFired(m) {
  flying = true;
  stopCountdown();
  fireBtn.disabled = true; fireBtn.textContent = "\u2026";
  GameView.animateFired(m, () => {
    // apply authoritative final tank state
    for (const nt of m.tanks) { const t = state.tanks.find((x) => x.id === nt.id); if (t) { t.x = nt.x; t.y = nt.y; t.hp = nt.hp; } }
    flying = false;
    syncHud();
  });
}

/* ---------------- game over ---------------- */
function onGameOver(m) {
  GameView.gameOver();
  stopCountdown();
  const el = $("msg");
  const won = m.winnerId === YOU;
  el.innerHTML = `${won ? "\ud83c\udfc6 You win!" : "\ud83d\udca5 " + esc(m.winnerName) + " wins"}<small>New match starting from the lobby\u2026</small>`;
  el.classList.remove("hidden");
  setTimeout(() => { el.classList.add("hidden"); show("room"); }, 4500);
}

connect();
