// Walk: Kenney tankBody sprites on lobby, room, HUD. BASE= live URL.
import { chromium } from "playwright";

const BASE = process.env.BASE || "https://hillshot.46.225.91.43.sslip.io";
const CHROME = process.env.CHROME || "";

function line(ok, ask, evidence) {
  const s = `${ok ? "PASS" : "FAIL"}  ${ask}  ${evidence}`;
  console.log(s);
  return s;
}

async function once(run) {
  const browser = await chromium.launch({
    executablePath: CHROME || undefined,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const out = [];
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 20000 });
    const lobby = await page.locator("#lobby img[src*='tankBody_']").count();
    out.push(line(lobby >= 2, "lobby shows tank assets", `${lobby} tankBody imgs`));

    await page.waitForFunction(() => !document.getElementById("createBtn")?.disabled, null, { timeout: 15000 });
    await page.fill("#name", "Walk" + run);
    await page.click("#createBtn");
    await page.waitForSelector("#roomCode", { timeout: 10000 });
    const room = await page.locator("#playerList img[src*='tankBody_']").count();
    out.push(line(room >= 1, "room list shows tank assets", `${room} tankBody imgs`));

    await page.click("#addBotBtn");
    await page.waitForTimeout(400);
    const room2 = await page.locator("#playerList img[src*='tankBody_']").count();
    out.push(line(room2 >= 2, "bot in the room also has a tank asset", `${room2} tankBody imgs`));

    await page.click("#startBtn");
    await page.waitForSelector("#game:not(.hidden)", { timeout: 10000 });
    await page.waitForTimeout(1500);
    const hud = await page.locator("#playersHud img[src*='tankBody_']").count();
    out.push(line(hud >= 2, "match HUD shows tank assets", `${hud} tankBody imgs`));
    const canvas = await page.locator("#cv canvas").count();
    out.push(line(canvas >= 1, "match canvas is up", `${canvas} canvas`));
    out.push(line(errs.length === 0, "no page errors", errs.length ? errs.join(" | ") : "0 pageerror"));
  } finally {
    await browser.close();
  }
  return out;
}

const a = await once(1);
console.log("--- run 2 ---");
const b = await once(2);
const same = JSON.stringify(a) === JSON.stringify(b);
console.log(same ? "RUNS MATCH" : "RUNS DIFFER");
process.exit(a.every((s) => s.startsWith("PASS")) && b.every((s) => s.startsWith("PASS")) && same ? 0 : 1);
