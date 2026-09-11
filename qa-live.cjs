// Headless visual QA: boot a real match locally and screenshot the tanks + aim guide.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const p1 = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p1.on("pageerror", (e) => errs.push("P1 " + e.message));
  p1.on("console", (m) => { if (m.type() === "error") errs.push("P1c " + m.text()); });
  await p1.goto("https://hillshot.46.225.91.43.sslip.io/");
  await p1.fill("#name", "Alice");
  await p1.click("#createBtn");
  await p1.waitForTimeout(700);
  const code = await p1.textContent("#roomCode").catch(() => null);
  console.log("room code:", code);

  await p1.click("#addBotBtn");
  await p1.waitForTimeout(300);
  await p1.click("#addBotBtn");
  await p1.waitForTimeout(400);
  await p1.click("#startBtn");
  await p1.waitForTimeout(2500);

  const shot = async (n) => { await p1.screenshot({ path: `/tmp/live-${n}.png` }); console.log("shot", n); };
  await shot("game");

  // hover mid-field to trigger point-to-aim guide
  const box = await p1.locator("canvas").boundingBox();
  console.log("canvas box", JSON.stringify(box));
  await p1.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.35);
  await p1.waitForTimeout(300);
  const before = await p1.textContent("#angleVal");
  await p1.mouse.down();
  await p1.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.22, { steps: 8 });
  await p1.waitForTimeout(250);
  await shot("pointaim");
  const afterA = await p1.textContent("#angleVal");
  const afterP = await p1.textContent("#powerVal");
  await p1.mouse.up();
  console.log("point-to-aim: angle", before, "->", afterA, "| power stayed", afterP);

  // keyboard: W raises power, shift+W by 5
  const p0 = await p1.textContent("#powerVal");
  await p1.keyboard.press("w"); await p1.keyboard.press("w");
  await p1.keyboard.down("Shift"); await p1.keyboard.press("W"); await p1.keyboard.up("Shift");
  const p2 = await p1.textContent("#powerVal");
  console.log("keys W,W,Shift+W: power", p0, "->", p2, "(expect +7)");

  // A/D angle
  const a0 = await p1.textContent("#angleVal");
  await p1.keyboard.press("a");
  const a1 = await p1.textContent("#angleVal");
  console.log("key A: angle", a0, "->", a1);

  // wheel over field trims power
  const w0 = await p1.textContent("#powerVal");
  await p1.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await p1.mouse.wheel(0, -120);
  await p1.waitForTimeout(200);
  const w1 = await p1.textContent("#powerVal");
  console.log("wheel up: power", w0, "->", w1);

  // weapon hotkey
  await p1.keyboard.press("3");
  console.log("key 3 -> weapon", await p1.inputValue("#weapon"));

  // slingshot near tank
  await p1.waitForTimeout(200);
  await shot("preslingshot");

  console.log(errs.length ? "JS ERRORS:\n" + errs.join("\n") : "no JS errors");
  await b.close();
})();
