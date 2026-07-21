// Touch-controls E2E (PLAN.md Phase 11): boots the client on an emulated
// touch device, drives the on-screen sticks with synthetic PointerEvents and
// asserts IN-SIM effects through the ?debug hook (globalThis.metropolisSim):
// the left stick moves the avatar, the right stick re-faces it, and the boot
// produced the touch overlay with no console/page errors. The pure stick math
// is unit-tested (touchMapping.test.ts); this covers the DOM wiring end-to-end.
//
//   bun run e2e:touch          # from the repo root
//
// Requires a Chromium binary (default /opt/pw-browsers/chromium, override with
// CHROMIUM_PATH) and vite (client dev server, spawned here on TOUCH_E2E_PORT).
// Renders through SwiftShader — no GPU needed (same setup as verify:arenas).

import { chromium } from "playwright-core";

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.TOUCH_E2E_PORT ?? "5179");
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_DIR = new URL("../../../packages/client", import.meta.url).pathname;

// Greybox render path: the harness asserts input→sim behavior, not assets, and
// skipping the map/unit glTFs keeps the SwiftShader boot fast and hermetic.
const URL_UNDER_TEST = `${BASE}/?touch=1&warden=1&debug&seed=1&render=greybox&map=test-128`;

/** One sim probe, evaluated in the page: avatar pose + tick, or null. */
interface Probe {
  tick: number;
  x: number;
  y: number;
  yaw: number;
}

async function main(): Promise<void> {
  console.log(`starting vite dev server on ${BASE} …`);
  const dev = Bun.spawn(
    ["bun", "x", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: CLIENT_DIR, stdout: "ignore", stderr: "inherit", env: { ...process.env } },
  );
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await fetch(BASE)
      .then((r) => r.ok)
      .catch(() => false);
    if (!ready) await Bun.sleep(500);
  }
  if (!ready) {
    dev.kill();
    console.error("dev server did not become ready");
    process.exit(1);
  }
  console.log("dev server ready");

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  // Phone-shaped touch context (landscape) — hasTouch also makes the client's
  // coarse-pointer auto-detect real, though the URL forces ?touch=1 anyway.
  const context = await browser.newContext({
    viewport: { width: 812, height: 375 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  console.log(`opening ${URL_UNDER_TEST}`);
  await page.goto(URL_UNDER_TEST, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForFunction(
    () => {
      const w = globalThis as { metropolisSim?: { tick: number } };
      return !!w.metropolisSim && w.metropolisSim.tick > 10; // sim built AND ticking
    },
    { timeout: 20000 },
  );

  // --- overlay present, body flagged ---------------------------------------
  // DOM types aren't in this package's lib (same as arenaShots.ts), so the
  // browser globals inside page.evaluate are typed structurally, locally.
  const overlay = await page.evaluate(() => {
    interface Doc {
      querySelector(sel: string): { style: { display: string } } | null;
      querySelectorAll(sel: string): { length: number };
      body: { classList: { contains(c: string): boolean } };
    }
    const doc = (globalThis as unknown as { document: Doc }).document;
    const root = doc.querySelector(".touch-root");
    return {
      hasBodyClass: doc.body.classList.contains("touch"),
      rootVisible: root !== null && root.style.display !== "none",
      buttons: doc.querySelectorAll(".touch-btn").length,
    };
  });

  // --- helpers ---------------------------------------------------------------
  /** Dispatches a synthetic touch PointerEvent on the overlay root. */
  const pointer = (type: string, x: number, y: number, id: number) =>
    page.evaluate(
      ([t, px, py, pid]) => {
        const g = globalThis as unknown as {
          document: { querySelector(sel: string): { dispatchEvent(e: unknown): boolean } | null };
          PointerEvent: new (type: string, init: Record<string, unknown>) => unknown;
        };
        const root = g.document.querySelector(".touch-root");
        root?.dispatchEvent(
          new g.PointerEvent(t as string, {
            pointerId: pid as number,
            pointerType: "touch",
            clientX: px as number,
            clientY: py as number,
            bubbles: true,
          }),
        );
      },
      [type, x, y, id] as const,
    );

  const probe = (): Promise<Probe | null> =>
    page.evaluate(() => {
      const w = globalThis as unknown as {
        metropolisSim?: {
          tick: number;
          avatarId: Int32Array;
          ent: { posX: Float32Array; posY: Float32Array; yaw: Float32Array };
        };
      };
      const s = w.metropolisSim;
      if (!s) return null;
      const a = s.avatarId[0];
      if (a < 0) return null;
      return { tick: s.tick, x: s.ent.posX[a], y: s.ent.posY[a], yaw: s.ent.yaw[a] };
    });

  /** Waits until the sim has stepped `n` more ticks (no fixed sleeps). */
  const advance = async (from: number, n: number) => {
    await page.waitForFunction(
      ([base, delta]) =>
        ((globalThis as { metropolisSim?: { tick: number } }).metropolisSim?.tick ?? 0) >=
        (base as number) + (delta as number),
      [from, n] as const,
      { timeout: 15000 },
    );
  };

  // --- left stick: drive forward, avatar must move ---------------------------
  const before = await probe();
  if (!before) throw new Error("avatar not present in sim");
  await pointer("pointerdown", 200, 280, 11);
  await pointer("pointermove", 200, 200, 11); // 80 px up-screen = full forward
  await advance(before.tick, 45); // 1.5 s of held stick
  const afterMove = await probe();
  await pointer("pointerup", 200, 200, 11);
  if (!afterMove) throw new Error("avatar vanished during move");
  const moved = Math.hypot(afterMove.x - before.x, afterMove.y - before.y);

  // --- right stick: engage aim, facing must change ----------------------------
  // Aim opposite-ish to the current yaw so the assertion can't pass by luck.
  const preAim = await probe();
  if (!preAim) throw new Error("avatar not present before aim");
  await pointer("pointerdown", 600, 280, 22);
  await pointer("pointermove", 540, 280, 22); // 60 px left-of-base aim drag
  await advance(preAim.tick, 30);
  const afterAim = await probe();
  await pointer("pointerup", 540, 280, 22);
  if (!afterAim) throw new Error("avatar vanished during aim");
  const wrap = (d: number) => Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  const turned = wrap(afterAim.yaw - preAim.yaw);

  // --- verdict ----------------------------------------------------------------
  const problems: string[] = [];
  if (!overlay.hasBodyClass) problems.push("body.touch class missing");
  if (!overlay.rootVisible) problems.push("touch overlay not visible in match");
  if (overlay.buttons !== 5) problems.push(`expected 5 touch buttons, got ${overlay.buttons}`);
  if (moved < 1) problems.push(`left stick barely moved the avatar (${moved.toFixed(2)} units)`);
  if (turned < 0.3)
    problems.push(`right stick barely turned the avatar (${turned.toFixed(2)} rad)`);
  if (errors.length) problems.push(`console/page errors: ${errors.join(" | ")}`);

  if (problems.length) {
    console.error(`FAIL touch e2e: ${problems.join("; ")}`);
  } else {
    console.log(
      `OK   touch e2e: overlay up, drive moved ${moved.toFixed(1)} units, ` +
        `aim turned ${turned.toFixed(2)} rad, no errors`,
    );
  }

  await browser.close();
  dev.kill();
  await dev.exited;
  process.exit(problems.length ? 1 : 0);
}

await main();
