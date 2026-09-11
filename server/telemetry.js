// Match telemetry. The point of this file is one question the team keeps asking and
// nobody can answer: "have two real humans, on two different machines, ever finished
// a full match?" Bot runs and headless QA can't answer it, so the server records it.
//
// Privacy: we never store an IP. Each client's address is salted+hashed to 12 hex
// chars, used only to tell "two different machines" from "one person in two tabs",
// and the salt is regenerated on every process start so hashes are not linkable
// across restarts.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const LOG = path.join(DATA_DIR, "matches.jsonl");
const SALT = crypto.randomBytes(16);

export function hashIp(req) {
  // Caddy APPENDS the real peer to any client-supplied X-Forwarded-For, so the LAST
  // entry is the trustworthy one. Reading the first entry would let a player spoof
  // their machine identity by sending their own header.
  const parts = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = parts.length ? parts[parts.length - 1] : ((req.socket && req.socket.remoteAddress) || "unknown");
  return crypto.createHash("sha256").update(SALT).update(ip).digest("hex").slice(0, 12);
}

// Participants are snapshotted when the match STARTS, not read at gameover: a loser
// who closes the tab the moment they die would otherwise erase the evidence that two
// humans were ever in the match.
export function newMatchStats(room) {
  const humans = (room ? room.players : []).filter((p) => !p.bot);
  return {
    startedAt: Date.now(),
    shots: 0,
    humanShots: 0,
    forfeits: 0,
    humansAtStart: humans.length,
    botsAtStart: (room ? room.players.length : 0) - humans.length,
    machinesAtStart: new Set(humans.map((p) => p.ipHash).filter(Boolean)).size,
  };
}

// Called on gameover. `room` carries players (with .ipHash on humans) and .stats.
export function recordMatch(room, winner) {
  try {
    const s = room.stats || newMatchStats(room);
    const rec = {
      ts: new Date().toISOString(),
      code: room.code,
      durationSec: Math.round((Date.now() - s.startedAt) / 1000),
      shots: s.shots,
      humanShots: s.humanShots,
      forfeits: s.forfeits,
      humans: s.humansAtStart,
      bots: s.botsAtStart,
      machines: s.machinesAtStart,
      // the metric the team actually wants: 2+ humans on 2+ distinct machines,
      // played to a real winner.
      humanVsHuman: s.humansAtStart >= 2 && s.machinesAtStart >= 2,
      // two humans sharing one machine (two tabs). Worth seeing, but it is NOT the metric.
      humanVsHumanSameMachine: s.humansAtStart >= 2 && s.machinesAtStart < 2,
      winner: winner ? winner.name : null,
      winnerWasBot: winner ? !!(room.players.find((p) => p.id === winner.id) || {}).bot : false,
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
    return rec;
  } catch (e) {
    console.error("telemetry write failed:", e.message);
    return null;
  }
}

function readAll() {
  try {
    return fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Served at GET /stats so the METRIC is a URL anyone can check, not a claim in chat.
export function statsSummary() {
  const all = readAll();
  const hvh = all.filter((m) => m.humanVsHuman);
  const withBot = all.filter((m) => m.bots > 0);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  return {
    metric: "matches played to a winner, by who was in them",
    matchesFinished: all.length,
    humanVsHumanFinished: hvh.length,
    humanVsHumanSameMachineFinished: all.filter((m) => m.humanVsHumanSameMachine).length,
    matchesWithBot: withBot.length,
    avgShotsPerMatch: avg(all.map((m) => m.shots)),
    avgDurationSec: avg(all.map((m) => m.durationSec)),
    totalForfeits: all.reduce((a, m) => a + (m.forfeits || 0), 0),
    lastMatchAt: all.length ? all[all.length - 1].ts : null,
    lastHumanVsHumanAt: hvh.length ? hvh[hvh.length - 1].ts : null,
    recent: all.slice(-10),
  };
}
