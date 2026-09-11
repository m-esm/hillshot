// Server-side AI opponent. Aims by simulating candidate shots against a clone
// of the live terrain/tanks with the real physics, then picks the best-scoring
// solution. Difficulty adds aim noise so bots are competent but beatable.

import { WORLD, makeTerrain, resolveFire, WEAPON_ORDER, WEAPONS } from "./game.js";

const BOT_NAMES = ["Boomer", "Aimbot", "Tank Jr", "Rusty", "Vulcan", "Havoc", "Sarge", "Crater"];
let botCounter = 0;

export function botName() {
  const n = BOT_NAMES[botCounter % BOT_NAMES.length];
  botCounter++;
  const suffix = botCounter > BOT_NAMES.length ? " " + Math.ceil(botCounter / BOT_NAMES.length) : "";
  return "🤖 " + n + suffix;
}

// A no-op socket so send()/broadcast() skip bots harmlessly.
export function botSocket() {
  return { readyState: 3, send() {}, bot: true };
}

// Clone terrain + tanks so a trial shot doesn't mutate real game state.
function cloneTerrain(terrain) { return Float32Array.from(terrain); }
function cloneTanks(tanks) {
  return tanks.map((t) => ({ id: t.id, x: t.x, y: t.y, hp: t.hp, facing: t.facing, name: t.name, color: t.color }));
}

function nearestEnemy(shooter, tanks) {
  let best = null, bd = Infinity;
  for (const t of tanks) {
    if (t.id === shooter.id || t.hp <= 0) continue;
    const d = Math.abs(t.x - shooter.x);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

// Score one candidate: net damage to enemies minus self-harm.
function trialScore(room, shooter, weapon, angle, power) {
  const terr = cloneTerrain(room.terrain);
  const tanks = cloneTanks(room.tanks);
  const sh = tanks.find((t) => t.id === shooter.id);
  if (!sh) return -Infinity;
  sh.wind = room.wind;
  sh.facing = shooter.facing;
  const before = new Map(tanks.map((t) => [t.id, t.hp]));
  resolveFire(terr, tanks, sh, weapon, angle, power);
  let score = 0;
  for (const t of tanks) {
    const dealt = before.get(t.id) - t.hp;
    if (t.id === shooter.id) score -= dealt * 2;       // avoid self-harm
    else score += dealt + (t.hp <= 0 ? 40 : 0);         // reward kills
  }
  return score;
}

// Find the best (weapon, angle, power) via coarse then fine search.
function solve(room, shooter) {
  const enemy = nearestEnemy(shooter, room.tanks);
  if (!enemy) return { weapon: "shot", angle: 45, power: 50 };
  shooter.facing = enemy.x > shooter.x ? 1 : -1;

  const weapons = ["shot", "bigshot", "roller"];
  let best = { weapon: "shot", angle: 45, power: 55, score: -Infinity };

  // coarse sweep
  for (const w of weapons) {
    for (let angle = 20; angle <= 75; angle += 5) {
      for (let power = 35; power <= 100; power += 5) {
        const s = trialScore(room, shooter, w, angle, power);
        if (s > best.score) best = { weapon: w, angle, power, score: s };
      }
    }
  }
  // fine sweep around the best
  const w = best.weapon;
  for (let angle = best.angle - 4; angle <= best.angle + 4; angle += 2) {
    for (let power = best.power - 4; power <= best.power + 4; power += 2) {
      if (angle < 5 || angle > 85 || power < 20 || power > 100) continue;
      const s = trialScore(room, shooter, w, angle, power);
      if (s > best.score) best = { weapon: w, angle, power, score: s };
    }
  }
  return best;
}

// Public: decide a bot's shot. `skill` 0..1 (default 0.7): higher = more accurate.
export function botDecide(room, shooter, skill = 0.72) {
  const sol = solve(room, shooter);
  // Aim noise inversely proportional to skill.
  const jitter = (1 - skill) * 16;
  const angle = Math.max(5, Math.min(85, sol.angle + (Math.random() - 0.5) * jitter));
  const power = Math.max(20, Math.min(100, sol.power + (Math.random() - 0.5) * jitter));
  return { weapon: sol.weapon, angle: Math.round(angle), power: Math.round(power) };
}
