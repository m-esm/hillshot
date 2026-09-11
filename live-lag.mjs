// Two independent WSS clients against the DEPLOYED server, each with injected
// one-way latency, to prove a full match completes under real-network delay.
// This is the case previously reported as "not measured".
import { WebSocket } from "ws";
const URL = "wss://hillshot.46.225.91.43.sslip.io/";
const LAT = Number(process.env.LAT_MS || 220); // one-way ms added to every send

function mk(name) {
  const ws = new WebSocket(URL);
  const c = { ws, name, id: null, code: null, shots: 0 };
  c.send = (o) => setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }, LAT);
  return c;
}
const A = mk("LagHost"), B = mk("LagGuest");
let started = false, done = false, t0 = 0;
const lat = [];
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

function wire(c, other) {
  c.ws.on("message", (raw) => {
    setTimeout(() => handle(c, other, JSON.parse(raw.toString())), LAT);
  });
}
function handle(c, other, m) {
  if (m.type === "joined") {
    c.id = m.you; c.code = m.code;
    if (c === A) { log("A room", m.code); B.ws.readyState === 1 ? B.send({ type: "join", code: m.code, name: B.name }) : setTimeout(() => B.send({ type: "join", code: A.code, name: B.name }), 300); }
    else { log("B joined"); A.send({ type: "ready", ready: true }); B.send({ type: "ready", ready: true }); setTimeout(() => A.send({ type: "start" }), 700); }
  }
  if (m.type === "error") log(c.name, "ERR", m.message);
  if (m.type === "forfeit") log("!! FORFEIT (turn timed out under lag) id=", m.id);
  if (m.type === "start") { if (!started) { started = true; log("MATCH START under", LAT, "ms one-way lag"); } fire(c, m.turnId); }
  if (m.type === "turn") fire(c, m.turnId);
  if (m.type === "fired") { if (c === A) { c.shots++; if (t0) lat.push(Date.now() - t0); } }
  if (m.type === "gameover" && !done) {
    done = true;
    const avg = lat.length ? Math.round(lat.reduce((x, y) => x + y, 0) / lat.length) : 0;
    log(`*** GAMEOVER winner: ${m.winnerName} | shots=${A.shots} | avg fire->broadcast ${avg}ms ***`);
    A.ws.close(); B.ws.close();
  }
}
function fire(c, turnId) {
  if (turnId !== c.id || done) return;
  setTimeout(() => { t0 = Date.now(); c.send({ type: "fire", weapon: "bigshot", angle: 30 + Math.floor(Math.random() * 40), power: 55 + Math.floor(Math.random() * 45) }); }, 250);
}
wire(A, B); wire(B, A);
A.ws.on("open", () => A.send({ type: "create", name: A.name }));
setTimeout(() => { if (!done) { log("TIMEOUT: no gameover under lag"); process.exit(1); } }, 280000);
