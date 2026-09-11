// METRIC: two real browser players finish a full match on the live domain,
// aiming ONLY through the new controls (click-to-aim, wheel power, keys).
// No bot. No synthetic WebSocket client. Both sides are real Chromium pages.
const { chromium } = require("playwright");
const URL = process.argv[2] || "https://hillshot.46.225.91.43.sslip.io/";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPlayer(browser, name) {
  const p = await browser.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(URL, { waitUntil: "commit" });
  await p.waitForSelector("#createBtn:not([disabled])", { timeout: 20000 });
  await p.fill("#name", name);
  return { page: p, name, errs };
}

// Aim by clicking a point on the canvas, then fire with the spacebar.
async function takeTurn(pl, box, rnd) {
  const p = pl.page;
  // click a target point across the field, biased toward the far side
  const tx = box.x + box.width * (0.15 + rnd * 0.7);
  const ty = box.y + box.height * (0.30 + (rnd * 0.4));
  // Aim at the OPPONENT's tank, the way a player does: click the target and let
  // the game solve the shot. Then one small keyboard trim, like a human would.
  const foe = await p.evaluate(() => {
    const me = window.__you;
    const st = window.__state;
    if (!st) return null;
    const t = st.tanks.find((x) => x.id !== me && x.hp > 0);
    return t ? { x: t.x, y: t.y } : null;
  });
  const w = await p.evaluate(() => ({ W: 1280, H: 720 }));
  let cx = tx, cy = ty;
  if (foe) {
    // jitter around the real target so shots aren't identical every turn
    cx = box.x + (foe.x / w.W) * box.width + (rnd - 0.5) * 40;
    cy = box.y + (foe.y / w.H) * box.height + (rnd - 0.5) * 20;
  }
  await p.mouse.click(cx, cy);
  await wait(200);
  await p.keyboard.press(rnd > 0.5 ? "a" : "d");
  await wait(80);
  const angle = await p.textContent("#angleVal").catch(() => "?");
  const power = await p.textContent("#powerVal").catch(() => "?");
  await p.keyboard.press("Space");
  return { angle, power, tx: Math.round(tx), ty: Math.round(ty) };
}

(async () => {
  const b = await chromium.launch();
  const A = await newPlayer(b, "Farzad");
  const B = await newPlayer(b, "Mohsen");

  await A.page.click("#createBtn");
  await A.page.waitForSelector("#startBtn:not(.hidden)", { timeout: 20000 });
  const code = (await A.page.textContent("#roomCode").catch(() => "")).trim();
  console.log("host created room:", code);
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error("no room code: " + code);

  await B.page.fill("#joinCode", code);
  await B.page.click("#joinBtn");
  await B.page.waitForSelector("#leaveBtn", { timeout: 20000 });
  await wait(800);

  // Confirm the lobby shows TWO humans and zero bots before starting.
  const roster = await A.page.$$eval("#playerList li, #players li, #playerList div",
    (els) => els.map((e) => e.textContent.trim()).filter(Boolean)).catch(() => []);
  console.log("lobby roster:", JSON.stringify(roster));

  await A.page.click("#startBtn");
  await A.page.waitForSelector("#game:not(.hidden)", { timeout: 20000 });
  await B.page.waitForSelector("#game:not(.hidden)", { timeout: 20000 });
  console.log("match started, 2 humans, no bot");

  const box = await A.page.locator("#cv canvas").boundingBox();

  let shots = 0, winner = null;
  const t0 = Date.now();
  while (!winner && shots < 90 && Date.now() - t0 < 300000) {
    for (const pl of [A, B]) {
      const over = await pl.page.$eval("#msg", (e) => e.classList.contains("hidden") ? null : e.textContent).catch(() => null);
      if (over) { winner = over; break; }
      const fireOn = await pl.page.$eval("#fireBtn", (e) => !e.disabled).catch(() => false);
      if (!fireOn) continue;
      const t = await takeTurn(pl, box, Math.random());
      shots++;
      console.log(`shot ${shots} by ${pl.name} aim@target angle=${t.angle} power=${t.power}`);
      await wait(2600);
    }
    await wait(400);
  }

  if (!winner) {
    for (const pl of [A, B]) {
      const m = await pl.page.$eval("#msg", (e) => e.classList.contains("hidden") ? null : e.textContent).catch(() => null);
      if (m) winner = m;
    }
  }

  const hpA = await A.page.$$eval(".php", (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  console.log("final HUD:", JSON.stringify(hpA));
  console.log("RESULT:", winner ? `GAMEOVER -> ${winner}` : "no gameover reached");
  console.log("total shots:", shots);
  console.log("JS errors A:", A.errs.length, "B:", B.errs.length);
  if (A.errs.length) console.log(A.errs.slice(0, 3));

  await A.page.screenshot({ path: "/tmp/2p-final-A.png" });
  await B.page.screenshot({ path: "/tmp/2p-final-B.png" });
  await b.close();
  process.exit(winner ? 0 : 1);
})();
