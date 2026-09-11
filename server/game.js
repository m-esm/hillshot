// Core deterministic game logic: terrain, projectile physics, weapons, damage.
// Runs authoritatively on the server. Clients only render what the server broadcasts.

export const WORLD = {
  W: 1280,          // world width (px)
  H: 720,           // world height (px)
  GRAV: 0.28,       // gravity accel per step
  STEP: 1 / 60,     // sim timestep marker (we step per-frame units)
  WIND_MAX: 15,     // wind range -15..+15
  WIND_ACCEL: 0.010,// horizontal accel per wind unit per step
  MAX_STEPS: 1600,  // safety cap on a single projectile flight
  TANK_W: 34,
  TANK_H: 16,
  MAX_HP: 100,
};

// --- seeded RNG (mulberry32) so a room shares identical terrain ---
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Heightmap terrain. terrain[x] = ground surface Y (smaller = higher).
export function makeTerrain(seed) {
  const r = rng(seed);
  const W = WORLD.W, H = WORLD.H;
  const base = H * 0.62 + (r() - 0.5) * H * 0.12;
  const h = new Float32Array(W);
  // layered sine hills + a little noise
  const layers = [
    { amp: H * 0.16 * (0.6 + r() * 0.8), len: 420 + r() * 260, ph: r() * Math.PI * 2 },
    { amp: H * 0.09 * (0.6 + r() * 0.8), len: 210 + r() * 130, ph: r() * Math.PI * 2 },
    { amp: H * 0.045 * (0.6 + r() * 0.8), len: 95 + r() * 70, ph: r() * Math.PI * 2 },
  ];
  for (let x = 0; x < W; x++) {
    let y = base;
    for (const l of layers) y += Math.sin((x / l.len) * Math.PI * 2 + l.ph) * l.amp;
    y += (r() - 0.5) * 6;
    h[x] = Math.max(H * 0.28, Math.min(H - 24, y));
  }
  // light smoothing pass
  for (let k = 0; k < 2; k++) {
    for (let x = 1; x < W - 1; x++) h[x] = (h[x - 1] + h[x] * 2 + h[x + 1]) / 4;
  }
  return h;
}

export function groundAt(terrain, x) {
  const xi = Math.max(0, Math.min(WORLD.W - 1, Math.round(x)));
  return terrain[xi];
}

// Carve a crater into the heightmap. Returns nothing (mutates terrain).
export function carve(terrain, cx, cy, radius) {
  const W = WORLD.W;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius));
  for (let x = x0; x <= x1; x++) {
    const dx = x - cx;
    const inside = radius * radius - dx * dx;
    if (inside <= 0) continue;
    const dy = Math.sqrt(inside);
    const craterBottom = cy + dy;   // lowest point of the removed circle at this column
    const craterTop = cy - dy;
    // Only remove ground that sits within the circle. Ground surface can only move DOWN.
    if (terrain[x] < craterBottom && terrain[x] >= craterTop - 4) {
      terrain[x] = Math.min(WORLD.H - 2, craterBottom);
    } else if (terrain[x] < craterTop) {
      // circle is fully in the air above ground -> no change
    } else if (terrain[x] >= craterBottom) {
      // ground already below crater -> no change
    }
  }
}

// Weapon catalogue. Each defines how the projectile behaves + explosion.
export const WEAPONS = {
  shot:     { name: "Shot",      color: "#ffd166", radius: 34, dmg: 34, kind: "single" },
  bigshot:  { name: "Big Shot",  color: "#f4a261", radius: 55, dmg: 55, kind: "single" },
  triple:   { name: "Tri-Shot",  color: "#8ecae6", radius: 26, dmg: 22, kind: "spread", count: 3, spreadDeg: 6 },
  roller:   { name: "Roller",    color: "#a3e635", radius: 40, dmg: 40, kind: "roller" },
  digger:   { name: "Digger",    color: "#c084fc", radius: 46, dmg: 46, kind: "digger", dig: 70 },
  airstrike:{ name: "Air Strike",color: "#ef476f", radius: 30, dmg: 20, kind: "airstrike", bombs: 5, spread: 130 },
};
export const WEAPON_ORDER = ["shot", "bigshot", "triple", "roller", "digger", "airstrike"];

// Simulate one projectile from (x,y) with velocity (vx,vy) under gravity+wind.
// Returns { path:[{x,y}...], hit:{x,y}|null, reason }
function flyOne(terrain, x, y, vx, vy, wind, tanks, ignoreId, opts = {}) {
  const path = [];
  let steps = 0;
  const digThrough = opts.digThrough || 0;
  let digged = 0;
  while (steps++ < WORLD.MAX_STEPS) {
    vy += WORLD.GRAV;
    vx += wind * WORLD.WIND_ACCEL;
    x += vx;
    y += vy;
    path.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
    // out of side/top bounds -> keep flying until it falls back, but kill if way off
    if (x < -80 || x > WORLD.W + 80) return { path, hit: null, reason: "offmap" };
    if (y > WORLD.H + 40) return { path, hit: null, reason: "offmap" };
    // tank hit?
    for (const t of tanks) {
      if (t.hp <= 0 || t.id === ignoreId) continue;
      if (Math.abs(x - t.x) <= WORLD.TANK_W / 2 + 4 && y >= t.y - WORLD.TANK_H && y <= t.y + 6) {
        return { path, hit: { x, y }, reason: "tank", tankId: t.id };
      }
    }
    // ground hit?
    if (y >= groundAt(terrain, x)) {
      if (digThrough && digged < digThrough) {
        // digger keeps going through ground for a bit
        digged += Math.abs(vy) + 1;
        continue;
      }
      return { path, hit: { x, y: groundAt(terrain, x) }, reason: "ground" };
    }
  }
  return { path, hit: { x, y }, reason: "timeout" };
}

// Apply an explosion at (cx,cy): carve terrain, damage tanks by distance falloff.
export function explode(terrain, tanks, cx, cy, radius, maxDmg) {
  carve(terrain, cx, cy, radius);
  const hits = [];
  for (const t of tanks) {
    if (t.hp <= 0) continue;
    const d = Math.hypot(t.x - cx, (t.y - WORLD.TANK_H / 2) - cy);
    if (d <= radius + WORLD.TANK_W / 2) {
      const falloff = Math.max(0, 1 - d / (radius + WORLD.TANK_W / 2));
      const dmg = Math.round(maxDmg * falloff);
      if (dmg > 0) {
        t.hp = Math.max(0, t.hp - dmg);
        hits.push({ id: t.id, dmg, hp: t.hp });
      }
    }
  }
  return hits;
}

// Settle tanks onto (possibly lowered) terrain after deformation.
export function settleTanks(terrain, tanks) {
  const fell = [];
  for (const t of tanks) {
    if (t.hp <= 0) continue;
    const g = groundAt(terrain, t.x);
    if (t.y < g - 1) { t.y = g; fell.push(t.id); }
    else t.y = g;
  }
  return fell;
}

// Resolve a full fire action. Returns a sequence of "shells" (paths + explosions)
// plus aggregated damage, so the client can animate them in order.
export function resolveFire(terrain, tanks, shooter, weaponKey, angleDeg, power) {
  const w = WEAPONS[weaponKey] || WEAPONS.shot;
  const shells = [];
  const totalHits = {};
  const addHits = (arr) => arr.forEach((h) => { totalHits[h.id] = (totalHits[h.id] || 0) + h.dmg; });

  const rad = (deg) => (deg * Math.PI) / 180;
  const speed = 4 + (power / 100) * 15;      // power 0..100 -> speed
  const dir = shooter.facing || 1;            // 1 right, -1 left (angle measured from horizontal)
  const muzzleX = shooter.x + Math.cos(rad(angleDeg)) * 22 * dir;
  const muzzleY = shooter.y - WORLD.TANK_H - 4 - Math.sin(rad(angleDeg)) * 22;

  const launches = [];
  if (w.kind === "spread") {
    const n = w.count, s = w.spreadDeg;
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * s;
      launches.push(angleDeg + off);
    }
  } else {
    launches.push(angleDeg);
  }

  for (const a of launches) {
    const vx = Math.cos(rad(a)) * speed * dir;
    const vy = -Math.sin(rad(a)) * speed;
    const opts = w.kind === "digger" ? { digThrough: w.dig } : {};
    const res = flyOne(terrain, muzzleX, muzzleY, vx, vy, shooter.wind, tanks, shooter.id, opts);
    let ex = null;
    if (res.hit) {
      const hits = explode(terrain, tanks, res.hit.x, res.hit.y, w.radius, w.dmg);
      addHits(hits);
      ex = { x: res.hit.x, y: res.hit.y, radius: w.radius };
    }
    shells.push({ path: res.path, explosion: ex, color: w.color });

    // Roller: after first ground impact, roll downhill then explode again bigger.
    if (w.kind === "roller" && res.reason === "ground" && res.hit) {
      let rx = res.hit.x;
      const rollPath = [];
      for (let k = 0; k < 240; k++) {
        const slopeL = groundAt(terrain, rx - 3), slopeR = groundAt(terrain, rx + 3);
        const step = slopeR < slopeL ? -2 : (slopeR > slopeL ? 2 : 0);
        if (step === 0) break;
        rx += step;
        rollPath.push({ x: Math.round(rx), y: Math.round(groundAt(terrain, rx)) });
        if (rx < 4 || rx > WORLD.W - 4) break;
      }
      if (rollPath.length) {
        const end = rollPath[rollPath.length - 1];
        const hits2 = explode(terrain, tanks, end.x, end.y, w.radius, w.dmg);
        addHits(hits2);
        shells.push({ path: rollPath, explosion: { x: end.x, y: end.y, radius: w.radius }, color: w.color, roll: true });
      }
    }

    // Air strike: primary impact spawns falling bombs across a spread.
    if (w.kind === "airstrike" && res.hit) {
      for (let i = 0; i < w.bombs; i++) {
        const bx = res.hit.x + (i - (w.bombs - 1) / 2) * (w.spread / w.bombs);
        const b = flyOne(terrain, bx, 0, 0, 6, shooter.wind, tanks, shooter.id, {});
        let bex = null;
        if (b.hit) {
          const hits3 = explode(terrain, tanks, b.hit.x, b.hit.y, w.radius, w.dmg);
          addHits(hits3);
          bex = { x: b.hit.x, y: b.hit.y, radius: w.radius };
        }
        shells.push({ path: b.path, explosion: bex, color: w.color, bomb: true });
      }
    }
  }

  const fell = settleTanks(terrain, tanks);
  return { shells, damage: totalHits, fell };
}

export function newWind() {
  return Math.round((Math.random() * 2 - 1) * WORLD.WIND_MAX);
}
