// One half of a two-machine match. Run `create` on one host and `join CODE` on
// another host with a different public IP; each side fires only on its own turn,
// so the server sees two humans from two addresses, exactly like two real players.
//   node qa-peer.mjs create
//   node qa-peer.mjs join ABCD [name]
import { WebSocket } from "ws";

const URL = process.env.WSS || "wss://hillshot.46.225.91.43.sslip.io/";
const role = process.argv[2];
const arg = process.argv[3];
const name = process.argv[4] || (role === "create" ? "HostPlayer" : "GuestPlayer");

const ws = new WebSocket(URL);
let YOU = null, shots = 0, done = false;
const t = () => new Date().toTimeString().slice(0, 8);
// Watchdog handle. A fixed timer that is never cleared will fire in the same tick as a
// late gameover and print TIMEOUT for a match that actually finished (seen at 292s vs a
// 300s limit). It is cleared the moment the match resolves, and it resets on every turn
// so it measures "the server went quiet", not "the match ran long".
let watchdog = null;
const IDLE_MS = Number(process.env.IDLE_MS) || 90000;
function armWatchdog() {
  clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (done) return;
    console.log(`${t()} TIMEOUT: no server activity for ${IDLE_MS / 1000}s (my shots ${shots})`);
    process.exit(1);
  }, IDLE_MS);
}

function fire() {
  shots++;
  ws.send(JSON.stringify({
    type: "fire", weapon: "shot",
    angle: 20 + Math.random() * 140,
    power: 55 + Math.random() * 45,
  }));
}

ws.on("open", () => {
  if (role === "create") ws.send(JSON.stringify({ type: "create", name }));
  else ws.send(JSON.stringify({ type: "join", code: String(arg).toUpperCase(), name }));
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  armWatchdog();
  if (m.type === "joined") { YOU = m.you; console.log(`${t()} CODE=${m.code} id=${YOU}`); }
  if (m.type === "error") console.log(`${t()} ERROR ${m.message}`);
  if (m.type === "lobby" && role === "create" && m.players.length >= 2) {
    setTimeout(() => ws.send(JSON.stringify({ type: "start" })), 400);
  }
  if ((m.type === "start" || m.type === "turn") && !done) {
    if (m.turnId === YOU) setTimeout(fire, 150);
  }
  if (m.type === "gameover" && !done) {
    done = true;
    clearTimeout(watchdog);
    console.log(`${t()} GAMEOVER winner=${m.winnerName} (my shots ${shots})`);
    setTimeout(() => process.exit(0), 300);
  }
});

armWatchdog();
