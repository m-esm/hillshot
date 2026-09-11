// Telemetry proof: two human sockets play to gameover. With DIFF_IPS=1 the second
// client presents a different X-Forwarded-For, which is what a real second machine
// behind Caddy looks like, so we can prove humanVsHuman flips true only in that case.
import { WebSocket } from "ws";

const URL = process.argv[2] || "ws://localhost:8099/";
const DIFF = process.env.DIFF_IPS === "1";

function mk(headers) { return new WebSocket(URL, headers ? { headers } : undefined); }

const a = mk({ "x-forwarded-for": "10.0.0.1" });
const b = mk({ "x-forwarded-for": DIFF ? "10.0.0.2" : "10.0.0.1" });

let code = null, ids = {}, turnId = null, started = false, done = false, shots = 0;
const sock = {};

function fire(ws) {
  // Deliberately crude aim; we only need the match to end, not to look good.
  ws.send(JSON.stringify({
    type: "fire", weapon: "shot",
    angle: 20 + Math.random() * 140,
    power: 60 + Math.random() * 40,
  }));
}

function wire(ws, who) {
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === "joined") { ids[who] = m.you; sock[m.you] = ws; if (who === "A") { code = m.code; b.send(JSON.stringify({ type: "join", code, name: "Bravo" })); } }
    if (m.type === "lobby" && who === "A" && m.players.length === 2 && !started) { started = true; setTimeout(() => a.send(JSON.stringify({ type: "start" })), 200); }
    if (m.type === "start" || m.type === "turn") {
      turnId = m.turnId !== undefined ? m.turnId : m.turnId;
      if (m.type === "start") turnId = m.turnId;
      if (who === "A" && turnId && sock[turnId] && !done) { shots++; setTimeout(() => fire(sock[turnId]), 120); }
    }
    if (m.type === "gameover" && !done) {
      done = true;
      console.log(`GAMEOVER winner=${m.winnerName} after ${shots} shots (DIFF_IPS=${DIFF ? 1 : 0})`);
      a.close(); b.close();
      setTimeout(() => process.exit(0), 200);
    }
  });
}

wire(a, "A"); wire(b, "B");
a.on("open", () => a.send(JSON.stringify({ type: "create", name: "Alpha" })));
setTimeout(() => { console.log("TIMEOUT no gameover after", shots, "shots"); process.exit(1); }, 180000);
