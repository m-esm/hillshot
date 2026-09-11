// Live proof against the DEPLOYED Hillshot server over WSS: 1 human + 1 bot to gameover.
import { WebSocket } from "ws";
const URL = process.argv[2] || "wss://hillshot.46.225.91.43.sslip.io/";
const ws = new WebSocket(URL);
let YOU = null, shots = 0, done = false;
const t = () => new Date().toTimeString().slice(0, 8);
ws.on("open", () => ws.send(JSON.stringify({ type: "create", name: "QA-Human" })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "joined") {
    YOU = m.you;
    console.log(t(), "room", m.code, "id", YOU);
    ws.send(JSON.stringify({ type: "addbot" }));
    setTimeout(() => ws.send(JSON.stringify({ type: "start" })), 600);
  }
  if (m.type === "lobby") console.log(t(), "lobby players:", m.players.map(p => p.name + (p.bot ? "(BOT)" : "")).join(", "));
  if (m.type === "error") console.log(t(), "ERR", m.message);
  if (m.type === "start") { console.log(t(), "MATCH START"); fire(m.turnId); }
  if (m.type === "turn") fire(m.turnId);
  if (m.type === "fired") console.log(t(), "shot", ++shots, "by", m.shooterId === YOU ? "human" : "BOT", "dmg", JSON.stringify(m.damage));
  if (m.type === "gameover") { done = true; console.log(t(), `*** GAMEOVER winner: ${m.winnerName} after ${shots} shots ***`); ws.close(); }
});
function fire(turnId) {
  if (turnId !== YOU || done) return;
  setTimeout(() => ws.send(JSON.stringify({
    type: "fire", weapon: "bigshot",
    angle: 35 + Math.floor(Math.random() * 30),
    power: 60 + Math.floor(Math.random() * 35),
  })), 500);
}
setTimeout(() => { if (!done) { console.log("TIMEOUT: no gameover"); process.exit(1); } }, 180000);
