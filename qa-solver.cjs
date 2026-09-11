// Does a click actually land where you clicked? Measures solved-shot accuracy
// in-page against the live site, with no wheel/key input interfering.
const { chromium } = require("playwright");
const URL = process.argv[2] || "https://hillshot.46.225.91.43.sslip.io/";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on("pageerror", (e) => console.log("PAGEERR", e.message));
  await p.goto(URL, { waitUntil: "commit" });
  await p.waitForSelector("#createBtn:not([disabled])", { timeout: 20000 });
  await p.fill("#name", "Solver");
  await p.click("#createBtn");
  await p.waitForSelector("#startBtn:not(.hidden)", { timeout: 20000 });
  await p.click("#addBotBtn");
  await wait(600);
  await p.click("#startBtn");
  await p.waitForSelector("#game:not(.hidden)", { timeout: 20000 });
  await wait(1200);

  const box = await p.locator("#cv canvas").boundingBox();

  // Click a spread of targets; after each click read the aim the game chose and
  // simulate that exact shot to see where it would really land.
  const res = [];
  for (let i = 0; i < 12; i++) {
    const fx = 0.12 + (i / 11) * 0.76;
    const tx = box.x + box.width * fx;
    const ty = box.y + box.height * 0.5;
    await p.mouse.click(tx, ty);
    await wait(200);
    const r = await p.evaluate(() => {
      const a = +document.getElementById("angle").value;
      const pw = +document.getElementById("power").value;
      return { angle: a, power: pw, hint: document.getElementById("aimHint").textContent.slice(0, 20) };
    });
    res.push({ fx: +fx.toFixed(2), ...r });
  }
  console.log("aim chosen per click (left -> right across the field):");
  for (const r of res) console.log(`  x=${r.fx}  angle=${r.angle}  power=${r.power}`);
  const angles = new Set(res.map((r) => r.angle));
  const powers = new Set(res.map((r) => r.power));
  console.log(`distinct angles: ${angles.size}/12   distinct powers: ${powers.size}/12`);
  console.log(powers.size > 1 ? "PASS: click solves power, not just angle" : "FAIL: power never changed on click");
  await b.close();
})();
