/* Hillshot — Phaser presentation layer.
   The server owns all physics/truth. This module only renders state and plays
   back the resolved shell animations the server broadcasts. app.js calls the
   GameView.* API; no game logic lives here.

   Public API (window.GameView):
     ready(cb)                          -> cb() once Phaser scene is created
     start(state)                       -> build terrain + tanks for a new match
     setAim(angle, power, weaponColor)  -> update local barrel + trajectory preview
     showAimFor(turnId, isYou)          -> whose turn; toggles preview
     animateFired(payload, onDone)      -> play shells, carve, explosions, then onDone()
     applyTankState(tanks)              -> snapshot HP/positions
     setWind(w)                         -> wind strength for ambient particles
     gameOver()                         -> stop preview
     mute(bool) / isMuted()
*/
(function () {
  "use strict";

  const WORLD = { W: 1280, H: 720, GRAV: 0.28, WIND_ACCEL: 0.010 };
  const SLING_R = 110;   // grab radius for slingshot aim
  const SLING_DIV = 1.4; // pull px -> power
  // Map server tank hex colors -> curated Kenney body/barrel asset keys.
  const COLOR_ASSET = [
    { hex: "#4cc9f0", key: "blue" },
    { hex: "#f72585", key: "red" },
    { hex: "#ffd166", key: "sand" },
    { hex: "#06d6a0", key: "green" },
    { hex: "#b5179e", key: "dark" },
    { hex: "#fb8500", key: "bigRed" },
    { hex: "#8ac926", key: "green" },
    { hex: "#ff595e", key: "red" },
  ];
  const ASSET_KEYS = ["blue", "red", "sand", "green", "dark", "bigRed"];
  function assetForColor(hex) {
    const m = COLOR_ASSET.find((c) => c.hex.toLowerCase() === String(hex).toLowerCase());
    return m ? m.key : "blue";
  }

  let game = null, scene = null, readyCbs = [], sceneReady = false;
  const S = {
    state: null,
    terrainGfx: null,
    tanks: new Map(),      // id -> { container, body, barrel, label, color }
    projLayer: null,
    fxLayer: null,
    trajGfx: null,
    guideGfx: null,
    slingMode: false,
    cursor: null,
    windGfx: null,
    windParticles: [],
    aim: { angle: 45, power: 50, color: "#ffd166" },
    previewOn: false,
    previewFor: null,
    muted: false,
  };

  /* ------------ Phaser scene ------------ */
  function preload() {
    const s = this;
    for (const k of ASSET_KEYS) {
      s.load.image("body_" + k, "assets/tanks/tankBody_" + k + ".png");
      s.load.image("barrel_" + k, "assets/tanks/barrel_" + k + ".png");
    }
    s.load.image("proj", "assets/fx/projectile.png");
    for (let i = 1; i <= 5; i++) s.load.image("smoke" + i, "assets/fx/explosionSmoke" + i + ".png");
    for (let i = 1; i <= 12; i++) s.load.image("exp" + i, "assets/exp/tank_explosion" + i + ".png");
    s.load.audio("fire", ["assets/audio/fire.ogg"]);
    s.load.audio("fire_big", ["assets/audio/fire_big.ogg"]);
    s.load.audio("explosion", ["assets/audio/explosion.ogg"]);
    s.load.audio("explosion_big", ["assets/audio/explosion_big.ogg"]);
    s.load.audio("hit", ["assets/audio/hit.ogg"]);
    s.load.audio("turn", ["assets/audio/turn.ogg"]);
    s.load.audio("click", ["assets/audio/click.ogg"]);
  }
  function capitalizeKey(k) { return k.charAt(0).toUpperCase() + k.slice(1); }

  function create() {
    scene = this;
    // background gradient sky (drawn once to a graphics, behind everything)
    const sky = this.add.graphics();
    sky.fillGradientStyle(0x0b1730, 0x0b1730, 0x173357, 0x143a63, 1);
    sky.fillRect(0, 0, WORLD.W, WORLD.H);
    // soft sun glow
    const glow = this.add.graphics();
    glow.fillStyle(0x1c3358, 0.5);
    glow.fillCircle(WORLD.W * 0.5, -40, 260);

    S.windGfx = this.add.graphics();
    S.terrainGfx = this.add.graphics();
    S.trajGfx = this.add.graphics();
    S.guideGfx = this.add.graphics();
    S.projLayer = this.add.container(0, 0);
    S.fxLayer = this.add.container(0, 0);

    // explosion animation from Kenney's 12-frame tank explosion sequence
    this.anims.create({
      key: "boom",
      frames: [
        { key: "exp1" }, { key: "exp2" }, { key: "exp3" }, { key: "exp4" },
        { key: "exp5" }, { key: "exp6" }, { key: "exp7" }, { key: "exp8" },
        { key: "exp9" }, { key: "exp10" }, { key: "exp11" }, { key: "exp12" },
      ],
      frameRate: 34,
      hideOnComplete: true,
    });

    // Drag-to-aim: press near your own tank and drag to set angle + power.
    // The pull direction (from tank toward pointer) sets the angle; pull length sets power.
    // Two aim gestures, chosen by where you grab:
    //   near your tank (<= SLING_R)  -> slingshot: drag sets BOTH angle and power
    //   anywhere else on the field   -> point-to-aim: angle follows the cursor,
    //                                   power stays as you set it (wheel / keys / slider)
    this.input.on("pointerdown", (p) => {
      if (!S.previewOn || !S.state) return;
      const sh = S.state.tanks.find((t) => t.id === S.previewFor);
      if (!sh || sh.hp <= 0) return;
      const wp = worldPoint(p);
      S.dragging = true;
      S.slingMode = Math.hypot(wp.x - sh.x, wp.y - (sh.y - 20)) <= SLING_R;
      updateDragAim(wp, sh);
    });
    this.input.on("pointermove", (p) => {
      if (!S.state) return;
      const sh = S.state.tanks.find((t) => t.id === S.previewFor);
      if (!sh) return;
      const wp = worldPoint(p);
      S.cursor = wp;
      if (S.dragging) updateDragAim(wp, sh);
      drawAimGuide(sh);
    });
    this.input.on("pointerup", () => { S.dragging = false; drawAimGuide(null); });
    this.input.on("pointerupoutside", () => { S.dragging = false; drawAimGuide(null); });

    // Mouse wheel over the field trims power (Shift = coarse x5).
    this.input.on("wheel", (p, objs, dx, dy) => {
      if (!S.previewOn || !S.onPowerNudge) return;
      const step = (p.event && p.event.shiftKey) ? 5 : 1;
      S.onPowerNudge(dy > 0 ? -step : step);
    });

    sceneReady = true;
    readyCbs.forEach((cb) => cb());
    readyCbs = [];
  }

  // Simulate a shot exactly like the server integrator and return its impact point.
  function simImpact(sh, angleDeg, power) {
    const dir = sh.facing < 0 ? -1 : 1;
    const rad = (angleDeg * Math.PI) / 180;
    const speed = 4 + (power / 100) * 15;
    let x = sh.x + Math.cos(rad) * 22 * dir;
    let y = sh.y - 20 - Math.sin(rad) * 22;
    let vx = Math.cos(rad) * speed * dir, vy = -Math.sin(rad) * speed;
    const wind = (S.state && S.state.wind) || 0;
    const T = S.state.terrain;
    for (let step = 0; step < 1200; step++) {
      vy += WORLD.GRAV; vx += wind * WORLD.WIND_ACCEL;
      x += vx; y += vy;
      if (x < 0 || x > WORLD.W || y > WORLD.H) return null;   // flew off the map
      if (y >= T[Math.max(0, Math.min(WORLD.W - 1, Math.round(x)))]) return { x, y };
    }
    return null;
  }

  // Click-to-target: solve for the angle+power that actually lands on the clicked
  // point, wind included. Coarse angle sweep, then power refined per angle, then a
  // local refine around the best pair. Always returns the BEST REACHABLE shot
  // (with .d = miss distance and .exact = within tolerance) so a click never
  // leaves the player with a stale power value and a wasted turn. Null only when
  // literally no shot lands on the map.
  function solveShot(sh, tx, ty) {
    let best = null;
    const score = (imp) => (imp ? Math.hypot(imp.x - tx, imp.y - ty) : Infinity);
    const consider = (a, pw) => {
      if (a < 1 || a > 179 || pw < 5 || pw > 100) return;
      const d = score(simImpact(sh, a, pw));
      if (d < (best ? best.d : Infinity)) best = { angle: a, power: pw, d };
    };
    for (let a = 5; a <= 175; a += 5) for (let pw = 10; pw <= 100; pw += 5) consider(a, pw);
    if (!best) return null;
    for (let a = best.angle - 4; a <= best.angle + 4; a++)
      for (let pw = best.power - 4; pw <= best.power + 4; pw++) consider(a, pw);
    // Return the closest shot we found either way. `exact` says whether it lands
    // where the player pointed; the caller colours the crosshair from that.
    best.exact = best.d <= 42;
    best.impact = simImpact(sh, best.angle, best.power);
    return best;
  }

  // Convert a Phaser pointer (canvas space) to world coords under FIT scaling.
  function worldPoint(p) {
    const cam = scene.cameras.main;
    return { x: p.worldX != null ? p.worldX : (p.x / cam.zoom), y: p.worldY != null ? p.worldY : (p.y / cam.zoom) };
  }

  // Pointer drag -> angle/power, reported back to app.js which owns the sliders.
  function updateDragAim(wp, sh) {
    const dir = sh.facing < 0 ? -1 : 1;
    const dx = (wp.x - sh.x) * dir;         // forward component in facing direction
    const dy = (sh.y - 20) - wp.y;          // up is positive
    let angle = Math.atan2(dy, dx) * 180 / Math.PI;
    angle = Math.max(0, Math.min(180, Math.round(angle)));
    if (!S.onAimDrag) return;
    if (S.slingMode) {
      const dist = Math.hypot(wp.x - sh.x, wp.y - (sh.y - 20));
      const power = Math.max(5, Math.min(100, Math.round(dist / SLING_DIV)));
      S.onAimDrag(angle, power);
    } else {
      // Point-to-aim: solve so the shell actually lands on the clicked spot.
      // If the exact point is unreachable we still commit the CLOSEST reachable
      // shot (angle AND power) instead of leaving stale power behind — an
      // unreachable click used to keep the previous power and burn a turn.
      const sol = solveShot(sh, wp.x, wp.y);
      if (sol) {
        S.lastSolved = !!sol.exact;
        S.solvedImpact = sol.impact || null;
        S.onAimDrag(sol.angle, sol.power);
      } else {
        S.lastSolved = false;
        S.solvedImpact = null;
        S.onAimDrag(angle, null);
      }
    }
    drawAimGuide(sh);
  }

  // Thin guide from the muzzle toward the cursor while aiming, plus the
  // slingshot grab ring so the near-tank gesture is discoverable.
  function drawAimGuide(sh) {
    const g = S.guideGfx;
    if (!g) return;
    g.clear();
    if (!sh || !S.previewOn || !S.cursor) return;
    const px = sh.x, py = sh.y - 20;
    g.lineStyle(1, 0x9fd0ff, S.dragging ? 0.5 : 0.22);
    g.strokeCircle(px, py, SLING_R);
    if (S.dragging) {
      const okCol = S.slingMode ? 0xffffff : (S.lastSolved ? 0x8ef2b0 : 0xff9a9a);
      g.lineStyle(1.5, okCol, 0.4);
      g.lineBetween(px, py, S.cursor.x, S.cursor.y);
      if (!S.slingMode) {
        g.lineStyle(1.6, okCol, 0.85);
        g.strokeCircle(S.cursor.x, S.cursor.y, 9);
        g.lineBetween(S.cursor.x - 13, S.cursor.y, S.cursor.x + 13, S.cursor.y);
        g.lineBetween(S.cursor.x, S.cursor.y - 13, S.cursor.x, S.cursor.y + 13);
        // Out of reach: show where the shot WILL actually land, so the amber
        // crosshair is an honest prediction rather than a plain rejection.
        if (!S.lastSolved && S.solvedImpact) {
          const im = S.solvedImpact;
          g.lineStyle(1.4, 0xffc46b, 0.9);
          g.strokeCircle(im.x, im.y, 7);
          g.lineStyle(1, 0xffc46b, 0.35);
          g.lineBetween(S.cursor.x, S.cursor.y, im.x, im.y);
        }
      }
    }
  }

  function update() {
    // ambient wind streaks
    if (!S.state) return;
    const w = S.state.wind || 0;
    S.windGfx.clear();
    if (Math.abs(w) >= 1) {
      if (S.windParticles.length < 46) {
        S.windParticles.push({ x: Math.random() * WORLD.W, y: Math.random() * WORLD.H * 0.7, len: 10 + Math.random() * 22 });
      }
      S.windGfx.lineStyle(1, 0xbcd4ff, 0.10);
      for (const p of S.windParticles) {
        p.x += w * 0.55;
        if (p.x > WORLD.W + 30) p.x = -30;
        if (p.x < -30) p.x = WORLD.W + 30;
        S.windGfx.lineBetween(p.x, p.y, p.x + p.len * Math.sign(w), p.y);
      }
    }
  }

  /* ------------ terrain ------------ */
  function drawTerrain() {
    const T = S.state.terrain, W = WORLD.W, H = WORLD.H;
    const g = S.terrainGfx;
    g.clear();
    const pts = [{ x: 0, y: H }];
    for (let x = 0; x < W; x += 2) pts.push({ x, y: T[x] });
    pts.push({ x: W - 1, y: T[W - 1] }, { x: W, y: H });
    // body
    g.fillStyle(0x274d33, 1);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) g.lineTo(p.x, p.y);
    g.closePath();
    g.fillPath();
    // grass top line
    g.lineStyle(3, 0x6fce6f, 1);
    g.beginPath();
    g.moveTo(0, T[0]);
    for (let x = 2; x < W; x += 2) g.lineTo(x, T[x]);
    g.strokePath();
  }

  function carveClient(cx, cy, radius) {
    const T = S.state.terrain, W = WORLD.W;
    const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(W - 1, Math.ceil(cx + radius));
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, inside = radius * radius - dx * dx;
      if (inside <= 0) continue;
      const bottom = cy + Math.sqrt(inside);
      if (T[x] < bottom) T[x] = Math.min(WORLD.H - 2, bottom);
    }
  }

  /* ------------ tanks ------------ */
  function buildTanks() {
    for (const [, t] of S.tanks) t.container.destroy();
    S.tanks.clear();
    for (const t of S.state.tanks) addTank(t);
  }

  // Ground slope under a tank, in radians, so the hull sits ON the hill
  // instead of floating flat across it. Sampled either side of the hull.
  function groundTilt(x) {
    const T = S.state && S.state.terrain;
    if (!T) return 0;
    const cl = (v) => Math.max(0, Math.min(WORLD.W - 1, Math.round(v)));
    const span = 22;
    const dy = T[cl(x + span)] - T[cl(x - span)];
    const a = Math.atan2(dy, span * 2);
    return Math.max(-0.6, Math.min(0.6, a));   // clamp so cliffs don't flip a tank
  }

  function addTank(t) {
    const c = scene.add.container(t.x, t.y);
    const base = Phaser.Display.Color.HexStringToColor(t.color).color;
    const dark = shade(base, -0.45);
    const lite = shade(base, 0.28);
    const dir = t.facing < 0 ? -1 : 1;

    const steel = 0x2b323c, steelLo = 0x171c23, steelHi = 0x4b5563;
    // Single near-black ink used for every silhouette edge. Outlining with a
    // darkened PLAYER colour (the old behaviour) gave a dark-cyan edge that
    // vanished against the night sky; one neutral ink makes the tank pop on
    // any background and keeps all parts reading as one object.
    const ink = 0x0c1016;

    // --- shadow ---
    const shadow = scene.add.ellipse(0, 3, 52, 11, 0x000000, 0.32);

    // --- running gear: track band, drive sprocket, idler, road wheels ---
    const tread = scene.add.graphics();
    // track band (outer silhouette)
    tread.fillStyle(steelLo, 1);
    tread.fillRoundedRect(-26, -13, 52, 15, 7);
    // inner void so the band reads as a loop
    tread.fillStyle(steel, 1);
    tread.fillRoundedRect(-22.5, -10.5, 45, 10, 5);
    // track cleats along the bottom run
    tread.fillStyle(steelLo, 1);
    for (let i = 0; i < 11; i++) tread.fillRect(-25 + i * 4.6, 0.2, 2.6, 2.2);
    // road wheels + sprocket/idler
    tread.fillStyle(steelHi, 1);
    for (let i = 0; i < 4; i++) tread.fillCircle(-13.5 + i * 9, -4.5, 4.2);
    tread.fillCircle(-21, -5.5, 5.4);   // rear drive sprocket
    tread.fillCircle(21, -5.5, 5.4);    // front idler
    tread.fillStyle(steelLo, 1);
    for (let i = 0; i < 4; i++) tread.fillCircle(-13.5 + i * 9, -4.5, 1.7);
    tread.fillCircle(-21, -5.5, 2.1);
    tread.fillCircle(21, -5.5, 2.1);
    tread.lineStyle(1.6, 0x0c1016, 1);
    tread.strokeRoundedRect(-26, -13, 52, 15, 7);

    // --- hull: sloped glacis, fender, engine deck ---
    const hull = scene.add.graphics();
    hull.fillStyle(base, 1);
    hull.beginPath();
    hull.moveTo(-25, -13);     // rear bottom
    hull.lineTo(-26, -19);     // rear plate
    hull.lineTo(-20, -23);     // engine deck rear
    hull.lineTo(14, -23);      // deck
    hull.lineTo(21, -18);      // sloped glacis toward the front
    hull.lineTo(22, -13.5);
    hull.closePath();
    hull.fillPath();
    // deck highlight
    hull.fillStyle(lite, 1);
    hull.fillRect(-19, -23, 32, 2.6);
    hull.fillTriangle(14, -22.6, 20.6, -18.4, 20.6, -16.8);
    // lower shadow + fender lip
    hull.fillStyle(dark, 1);
    hull.fillRect(-24, -15.6, 45, 2.2);
    hull.fillRect(-25.5, -14.4, 47.5, 1.5);
    // accent stripe (player colour reads at a glance even when tinted dark)
    hull.fillStyle(lite, 1);
    hull.fillRect(-14, -19.5, 6, 3.4);
    hull.fillStyle(dark, 1);
    hull.fillRect(-5, -19.5, 3, 3.4);
    // engine louvres
    hull.lineStyle(1, dark, 0.9);
    for (let i = 0; i < 4; i++) hull.lineBetween(-18 + i * 3.4, -22.2, -18 + i * 3.4, -17.5);
    // silhouette edge in neutral ink (was `dark`, i.e. tinted and invisible at night)
    hull.lineStyle(1.6, ink, 1);
    hull.strokePath();
    // sun-side rim light along the deck so the hull reads as a solid volume
    hull.lineStyle(1.1, shade(base, 0.55), 0.75);
    hull.lineBetween(-19.5, -23.4, 13.8, -23.4);
    hull.lineBetween(14, -23.2, 20.8, -18.2);
    if (dir < 0) hull.setScale(-1, 1);

    // --- turret: mantlet + cupola, pivot at (0,-20) ---
    const turret = scene.add.graphics();
    turret.fillStyle(base, 1);
    turret.slice(0, -23, 12.5, Phaser.Math.DegToRad(180), Phaser.Math.DegToRad(360), false);
    turret.fillPath();
    turret.fillStyle(lite, 1);
    turret.slice(0, -23, 12.5, Phaser.Math.DegToRad(200), Phaser.Math.DegToRad(300), false);
    turret.fillPath();
    turret.fillStyle(base, 1);
    turret.fillRoundedRect(-12.5, -23.5, 25, 5, 2);
    turret.fillStyle(dark, 1);
    turret.fillRect(-12.5, -19.5, 25, 1.6);
    // commander cupola
    turret.fillStyle(lite, 1);
    turret.fillRoundedRect(-8, -31, 8, 4.5, 2);
    turret.fillStyle(dark, 1);
    turret.fillRect(-8, -27.2, 8, 1.4);
    // antenna
    turret.lineStyle(1.2, 0x1b2027, 0.9);
    turret.lineBetween(-9, -31, -13, -41);
    // turret silhouette: the dome and cupola had NO outline, so the turret
    // dissolved into the sky. Ink the dome arc, the ring and the cupola.
    turret.lineStyle(1.5, ink, 1);
    turret.beginPath();
    turret.arc(0, -23, 12.5, Phaser.Math.DegToRad(180), Phaser.Math.DegToRad(360), false);
    turret.strokePath();
    turret.strokeRoundedRect(-12.5, -23.5, 25, 5, 2);
    turret.strokeRoundedRect(-8, -31, 8, 4.5, 2);
    if (dir < 0) turret.setScale(-1, 1);

    // --- barrel: tapered tube, mantlet collar, muzzle brake ---
    const barrel = scene.add.graphics();
    barrel.fillStyle(0x9aa4ad, 1);
    barrel.fillRoundedRect(-1, -4.2, 8, 8.4, 2.5);    // mantlet collar
    // Tube TAPERS toward the muzzle (was a plain rectangle, which is what made
    // the gun read as a grey stick rather than an artillery piece).
    barrel.fillStyle(0xc3cbd4, 1);
    barrel.fillPoints([
      { x: 6, y: -3.4 }, { x: 26, y: -2.5 },
      { x: 26, y: 2.5 }, { x: 6, y: 3.4 },
    ], true);
    barrel.fillStyle(0xd9e0e8, 1);
    barrel.fillPoints([
      { x: 6, y: -3.4 }, { x: 26, y: -2.5 },
      { x: 26, y: -1.1 }, { x: 6, y: -1.5 },
    ], true);                                          // top light
    barrel.fillStyle(0x7c8791, 1);
    barrel.fillPoints([
      { x: 6, y: 1.6 }, { x: 26, y: 1.2 },
      { x: 26, y: 2.5 }, { x: 6, y: 3.4 },
    ], true);                                          // bottom shade
    barrel.fillStyle(0xaab4bd, 1);
    barrel.fillRoundedRect(25, -4.6, 7, 9.2, 2);      // muzzle brake
    barrel.fillStyle(0x1a1f26, 1);
    barrel.fillRect(28, -1.3, 4.5, 2.6);              // bore
    // ink the gun so it stays legible against sky and terrain alike
    barrel.lineStyle(1.2, ink, 1);
    barrel.strokeRoundedRect(25, -4.6, 7, 9.2, 2);
    barrel.strokeRoundedRect(-1, -4.2, 8, 8.4, 2.5);
    barrel.x = 0; barrel.y = -20;

    // muzzle flash (hidden until fire)
    const flash = scene.add.image(32, -20, "proj").setScale(0).setTint(0xffe08a);

    // name label
    const label = scene.add.text(0, -56, t.name, {
      fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "15px", color: "#e8eef6",
      stroke: "#0c1422", strokeThickness: 4,
    }).setOrigin(0.5, 1);

    c.add([shadow, tread, hull, turret, barrel, flash, label]);
    // hull rides the slope; the name label stays upright and readable
    const tilt = groundTilt(t.x);
    c.rotation = tilt;
    label.rotation = -tilt;
    S.tanks.set(t.id, { container: c, hull, barrel, flash, label, color: t.color, facing: t.facing });
    aimBarrel(t.id, S.aim.angle);
  }

  // Lighten (amt>0) or darken (amt<0) a packed rgb int.
  function shade(rgb, amt) {
    let r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
    const f = amt < 0 ? 1 + amt : 1;
    const add = amt > 0 ? amt * 255 : 0;
    r = Math.max(0, Math.min(255, Math.round(r * f + add)));
    g = Math.max(0, Math.min(255, Math.round(g * f + add)));
    b = Math.max(0, Math.min(255, Math.round(b * f + add)));
    return (r << 16) | (g << 8) | b;
  }

  function aimBarrel(id, angleDeg) {
    const tk = S.tanks.get(id);
    if (!tk) return;
    const dir = tk.facing < 0 ? -1 : 1;
    // The barrel is a child of a container that is rotated to the ground slope,
    // so subtract that tilt: the gun must point at the WORLD angle the server
    // actually fires at, not an angle relative to the hull.
    const tilt = tk.container ? tk.container.rotation : 0;
    tk.barrel.rotation = -angleDeg * Math.PI / 180 * dir + (dir < 0 ? Math.PI : 0) - tilt;
    tk.flash.x = 0 + Math.cos(tk.barrel.rotation) * 34;
    tk.flash.y = -20 + Math.sin(tk.barrel.rotation) * 34;
  }

  // Fire feedback: muzzle flash + recoil on the shooter's barrel.
  function muzzleKick(id) {
    const tk = S.tanks.get(id);
    if (!tk) return;
    tk.flash.setScale(1.4).setAlpha(1);
    scene.tweens.add({ targets: tk.flash, scale: 0, alpha: 0, duration: 220, ease: "Quad.out" });
    const restX = 0, restY = -20;
    const back = tk.barrel.rotation + Math.PI; // recoil opposite to aim
    tk.barrel.x = restX + Math.cos(back) * 4;
    tk.barrel.y = restY + Math.sin(back) * 4;
    scene.tweens.add({ targets: tk.barrel, x: restX, y: restY, duration: 260, ease: "Back.out" });
  }

  function settleTankSprites(tanks) {
    for (const nt of tanks) {
      const tk = S.tanks.get(nt.id);
      if (!tk) continue;
      const tilt = groundTilt(nt.x);
      scene.tweens.add({ targets: tk.container, x: nt.x, y: nt.y, rotation: tilt, duration: 220, ease: "Quad.out" });
      if (tk.label) scene.tweens.add({ targets: tk.label, rotation: -tilt, duration: 220, ease: "Quad.out" });
      // terrain moved under the tank -> re-solve the barrel against the new tilt
      if (nt.hp > 0) scene.time.delayedCall(230, () => aimBarrel(nt.id, S.aim.angle));
      if (nt.hp <= 0 && !tk.dead) {
        tk.dead = true;
        scene.tweens.add({ targets: tk.container, alpha: 0.28, rotation: groundTilt(nt.x) + 0.22, duration: 400 });
      }
    }
  }

  /* ------------ trajectory preview ------------ */
  function drawTrajectory() {
    const g = S.trajGfx;
    g.clear();
    if (!S.previewOn || !S.state) return;
    const shooter = S.state.tanks.find((t) => t.id === S.previewFor);
    if (!shooter || shooter.hp <= 0) return;
    const dir = shooter.facing < 0 ? -1 : 1;
    const rad = (S.aim.angle * Math.PI) / 180;
    const speed = 4 + (S.aim.power / 100) * 15;
    let x = shooter.x + Math.cos(rad) * 22 * dir;
    let y = shooter.y - 20 - Math.sin(rad) * 22;
    let vx = Math.cos(rad) * speed * dir, vy = -Math.sin(rad) * speed;
    const wind = S.state.wind || 0;
    const col = Phaser.Display.Color.HexStringToColor(S.aim.color).color;
    // Fine 1:1 sim (matches server) so it never tunnels through steep terrain,
    // sampled every few steps as dots. Predicts up to the real impact point.
    const T = S.state.terrain;
    let dot = 0;
    for (let step = 0; step < 900; step++) {
      vy += WORLD.GRAV; vx += wind * WORLD.WIND_ACCEL;
      x += vx; y += vy;
      if (x < 0 || x > WORLD.W || y > WORLD.H) break;
      if (y >= T[Math.max(0, Math.min(WORLD.W - 1, Math.round(x)))]) {
        // mark the predicted impact
        g.fillStyle(0xffffff, 0.85); g.fillCircle(x, y, 4);
        g.lineStyle(2, col, 0.7); g.strokeCircle(x, y, 7);
        break;
      }
      if (step % 7 === 0) {
        const a = 0.85 - dot / 46;
        g.fillStyle(col, Math.max(0.14, a));
        g.fillCircle(x, y, dot < 3 ? 3 : 2.2);
        dot++;
      }
    }
  }

  /* ------------ shell playback ------------ */
  function playShells(shells, finalTanks, damage, onDone) {
    if (!shells.length) { finishFire(finalTanks, damage, onDone); return; }
    const shell = shells.shift();
    animateShell(shell, () => playShells(shells, finalTanks, damage, onDone));
  }

  function animateShell(shell, done) {
    const path = shell.path;
    if (!path || !path.length) { if (shell.explosion) doExplosion(shell.explosion, shell); done(); return; }
    const spr = scene.add.image(path[0].x, path[0].y, "proj").setScale(0.5);
    S.projLayer.add(spr);
    // launch sound
    if (!shell.bomb) sfx(shell.explosion && shell.explosion.radius >= 50 ? "fire_big" : "fire", 0.4);
    const step = shell.bomb ? 3 : (shell.roll ? 4 : 2);
    let i = 0;
    const trail = [];
    const tick = () => {
      i += step;
      const idx = Math.min(path.length - 1, Math.floor(i));
      const p = path[idx];
      spr.x = p.x; spr.y = p.y;
      if (idx > 1) { const prev = path[Math.max(0, idx - step)]; spr.rotation = Math.atan2(p.x - prev.x, -(p.y - prev.y)); }
      // fading trail dot
      const dot = scene.add.circle(p.x, p.y, 2.4, 0xffd27f, 0.8);
      S.projLayer.add(dot);
      trail.push(dot);
      scene.tweens.add({ targets: dot, alpha: 0, scale: 0.2, duration: 380, onComplete: () => dot.destroy() });
      if (idx >= path.length - 1) {
        spr.destroy();
        if (shell.explosion) doExplosion(shell.explosion, shell);
        done();
        return;
      }
      scene.time.delayedCall(16, tick);
    };
    tick();
  }

  function doExplosion(ex, shell) {
    const big = ex.radius >= 50;
    // sprite animation scaled to blast radius (full-color art, no tint)
    const boom = scene.add.sprite(ex.x, ex.y, "exp1").setScale(ex.radius / 32 * 1.6);
    S.fxLayer.add(boom);
    boom.play("boom");
    boom.once("animationcomplete", () => boom.destroy());
    // flash
    const flash = scene.add.circle(ex.x, ex.y, ex.radius * 0.8, 0xfff2c0, 0.85);
    S.fxLayer.add(flash);
    scene.tweens.add({ targets: flash, alpha: 0, scale: 1.5, duration: 220, onComplete: () => flash.destroy() });
    // expanding shock ring
    const ring = scene.add.circle(ex.x, ex.y, 4);
    ring.setStrokeStyle(3, 0xffd166, 0.9); ring.setFillStyle();
    S.fxLayer.add(ring);
    scene.tweens.add({ targets: ring, radius: ex.radius * 1.4, alpha: 0, duration: 380,
      onUpdate: () => ring.setStrokeStyle(3, 0xffd166, ring.alpha), onComplete: () => ring.destroy() });
    // spark particles
    const n = Math.round(ex.radius * 0.9);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * ex.radius * 0.16 + 1;
      const col = Math.random() < 0.5 ? 0xffae42 : 0xff5a3c;
      const pt = scene.add.circle(ex.x, ex.y, 1 + Math.random() * 3, col);
      S.fxLayer.add(pt);
      scene.tweens.add({ targets: pt, x: ex.x + Math.cos(a) * sp * 22, y: ex.y + Math.sin(a) * sp * 22 + 30,
        alpha: 0, duration: 500 + Math.random() * 400, onComplete: () => pt.destroy() });
    }
    // camera shake + sound + carve
    scene.cameras.main.shake(big ? 320 : 200, big ? 0.012 : 0.007);
    sfx(big ? "explosion_big" : "explosion", 0.6);
    carveClient(ex.x, ex.y, ex.radius);
    drawTerrain();
  }

  function finishFire(finalTanks, damage, onDone) {
    for (const id in damage) {
      const t = S.state.tanks.find((x) => x.id === id);
      if (t && damage[id] > 0) floatDamage(t.x, t.y - 30, damage[id]);
    }
    if (Object.keys(damage).length) sfx("hit", 0.5);
    applyTankState(finalTanks);
    settleTankSprites(finalTanks);
    if (onDone) onDone();
  }

  function floatDamage(x, y, dmg) {
    const txt = scene.add.text(x, y, "-" + dmg, {
      fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "26px", fontStyle: "bold",
      color: "#ff5a5a", stroke: "#0c1422", strokeThickness: 5,
    }).setOrigin(0.5);
    S.fxLayer.add(txt);
    scene.tweens.add({ targets: txt, y: y - 54, alpha: 0, duration: 1200, ease: "Quad.out", onComplete: () => txt.destroy() });
  }

  /* ------------ sound ------------ */
  function sfx(key, vol) {
    if (S.muted || !scene || !scene.sound) return;
    try { scene.sound.play(key, { volume: vol == null ? 0.5 : vol }); } catch (e) { /* not loaded yet */ }
  }

  /* ------------ public API ------------ */
  const API = {
    boot() {
      if (game) return;
      const config = {
        type: Phaser.AUTO,
        parent: "cv",
        backgroundColor: "#0b1730",
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: WORLD.W, height: WORLD.H },
        audio: { disableWebAudio: false },
        scene: { preload, create, update },
        render: { antialias: true, powerPreference: "high-performance" },
      };
      game = new Phaser.Game(config);
    },
    ready(cb) { if (sceneReady) cb(); else readyCbs.push(cb); },
    start(state) {
      S.state = state;
      // Phaser may have booted while #cv was display:none (0x0). Recompute scale
      // now that the game screen is visible so FIT uses the real container size.
      if (scene && scene.scale) {
        scene.scale.refresh();
        requestAnimationFrame(() => scene.scale.refresh());
        setTimeout(() => scene.scale.refresh(), 60);
      }
      // unlock audio on first user gesture (start click already happened)
      if (scene && scene.sound && scene.sound.locked) scene.sound.once("unlocked", () => {});
      drawTerrain();
      buildTanks();
      S.windParticles = [];
    },
    setWind(w) { if (S.state) S.state.wind = w; },
    setAim(angle, power, color) {
      S.aim.angle = angle; S.aim.power = power; if (color) S.aim.color = color;
      if (S.previewFor) aimBarrel(S.previewFor, angle);
      drawTrajectory();
    },
    showAimFor(turnId, isYou) {
      S.previewFor = turnId;
      S.previewOn = !!isYou;
      // point every idle barrel at its default; active one uses current aim
      if (turnId) aimBarrel(turnId, S.aim.angle);
      drawTrajectory();
      sfx("turn", 0.35);
    },
    animateFired(payload, onDone) {
      S.previewOn = false;
      drawTrajectory();
      // aim the shooter's barrel at the actual shot, then kick it
      if (payload.shooterId != null) {
        if (payload.angle != null) aimBarrel(payload.shooterId, payload.angle);
        muzzleKick(payload.shooterId);
      }
      playShells(payload.shells.slice(), payload.tanks, payload.damage, onDone);
    },
    applyTankState(tanks) { applyTankState(tanks); },
    gameOver() { S.previewOn = false; if (S.trajGfx) S.trajGfx.clear(); },
    flash(text) {
      if (!scene) return;
      const t = scene.add.text(WORLD.W / 2, WORLD.H * 0.28, text, {
        fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "30px", fontStyle: "bold",
        color: "#ffd166", stroke: "#0c1422", strokeThickness: 6, align: "center",
      }).setOrigin(0.5).setDepth(1000);
      S.fxLayer.add(t);
      scene.tweens.add({ targets: t, y: WORLD.H * 0.22, alpha: 0, duration: 1800, ease: "Quad.out", onComplete: () => t.destroy() });
    },
    mute(b) { S.muted = !!b; if (scene && scene.sound) scene.sound.mute = S.muted; },
    isMuted() { return S.muted; },
    onAimDrag(cb) { S.onAimDrag = cb; },
    onPowerNudge(cb) { S.onPowerNudge = cb; },
  };

  function applyTankState(tanks) {
    if (!S.state) return;
    for (const nt of tanks) {
      const t = S.state.tanks.find((x) => x.id === nt.id);
      if (t) { t.x = nt.x; t.y = nt.y; t.hp = nt.hp; }
    }
  }

  window.GameView = API;
})();
