// Test bot: joins a room, readies, fires random-ish shots on its turn.
import { WebSocket } from "ws";
const [code, name] = [process.argv[2], process.argv[3] || "Bot"];
const ws = new WebSocket("ws://localhost:8090");
let YOU = null;
ws.on("open", () => {
  if (code) ws.send(JSON.stringify({ type: "join", code, name }));
  else ws.send(JSON.stringify({ type: "create", name }));
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "joined") { YOU = m.you; console.log(name, "joined", m.code, "id", YOU); }
  if (m.type === "error") console.log(name, "ERR", m.message);
  if (m.type === "start") { console.log(name, "game start, my turn?", m.turnId === YOU); maybeFire(m.turnId); }
  if (m.type === "turn") maybeFire(m.turnId);
  if (m.type === "fired") console.log(name, "saw fire by", m.shooterId, "dmg", JSON.stringify(m.damage));
  if (m.type === "gameover") { console.log(name, "GAME OVER winner", m.winnerName); }
});
function maybeFire(turnId) {
  if (turnId !== YOU) return;
  setTimeout(() => {
    const angle = 30 + Math.floor(Math.random() * 40);
    const power = 55 + Math.floor(Math.random() * 30);
    const weapon = ["shot", "bigshot", "triple", "roller", "digger", "airstrike"][Math.floor(Math.random() * 6)];
    console.log(name, "firing", weapon, angle, power);
    ws.send(JSON.stringify({ type: "fire", weapon, angle, power }));
  }, 800);
}
