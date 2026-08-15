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

import {
  collectDiagnostics,
  launchBrowser,
  newHarnessContext,
  startDevServer,
} from "./browserLaunch";

const PORT = Number(process.env.TOUCH_E2E_PORT ?? "5179");
const BASE = `http://127.0.0.1:${PORT}`;

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
  const dev = await startDevServer(PORT);
  const browser = await launchBrowser();
  // Phone-shaped touch context (landscape) — hasTouch also makes the client's
  // coarse-pointer auto-detect real, though the URL forces ?touch=1 anyway.
  const context = await newHarnessContext(browser, { width: 812, height: 375, touch: true });
  const page = await context.newPage();

  // Same set as the hand-rolled collectors this replaced: console errors plus
  // uncaught page errors. The diagnostics' asset/fallback signals go unused here.
  const { errors } = collectDiagnostics(page);

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

  /**
   * Waits until the avatar is alive, buffs it out of killing range, and
   * returns its pose. The d1 Warden kills an unattended avatar on this map
   * from ~tick 96 on — on a fast dev machine the whole script finishes before
   * that, but on software GL (this CI-less verification environment) shader
   * compilation eats seconds of boot and the phases land inside kill windows,
   * with respawn-teleports zeroing the measured movement. This harness asserts
   * input plumbing, not survivability, so the test avatar simply must not die:
   * hp is re-buffed before every phase (the ammo/repair pad would otherwise
   * clamp it back). Debug-hook poke, same class as metropolisSpawn — the map
   * is a sandbox no golden covers.
   */
  const awaitAlive = async (): Promise<Probe> => {
    await page.waitForFunction(
      () =>
        ((globalThis as { metropolisSim?: { avatarId: Int32Array } }).metropolisSim?.avatarId[0] ??
          -1) >= 0,
      null,
      { timeout: 20000 }, // respawn is 8 s of sim time
    );
    await page.evaluate(() => {
      const g = globalThis as unknown as {
        metropolisSim?: { avatarId: Int32Array; ent: { hp: Int32Array | Float32Array } };
      };
      const s = g.metropolisSim;
      if (!s) return;
      const a = s.avatarId[0];
      if (a >= 0) s.ent.hp[a] = 1000000;
    });
    const p = await probe();
    if (!p) throw new Error("avatar not present after alive-wait");
    return p;
  };

  /** One stick hold: pose before, drag, `holdTicks`, pose after (or null). */
  const stickHold = async (
    id: number,
    base: readonly [number, number],
    drag: readonly [number, number],
    holdTicks: number,
    before: Probe,
  ): Promise<Probe | null> => {
    await pointer("pointerdown", base[0], base[1], id);
    await pointer("pointermove", drag[0], drag[1], id);
    await advance(before.tick, holdTicks);
    const after = await probe();
    await pointer("pointerup", drag[0], drag[1], id);
    return after;
  };

  // Both phases run as one unit and retry together after a death: the aim
  // assertion's geometry ("drag left of the base ≈ 90° off the current yaw")
  // only holds right after the move phase established that yaw — a respawned
  // avatar can face any way, including exactly where the fixed drag points.
  let moved = 0;
  let turned = 0;
  const wrap = (d: number) => Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
  for (let attempt = 0; ; attempt++) {
    // --- left stick: drive forward (80 px up-screen = full forward, 1.5 s) --
    const before = await awaitAlive();
    const afterMove = await stickHold(11, [200, 280], [200, 200], 45, before);
    if (afterMove) {
      moved = Math.hypot(afterMove.x - before.x, afterMove.y - before.y);
      // --- right stick: engage aim, facing must change ----------------------
      // Aim opposite-ish to the yaw the move phase just established.
      const preAim = await probe();
      if (preAim) {
        const afterAim = await stickHold(22, [600, 280], [540, 280], 30, preAim);
        if (afterAim) {
          turned = wrap(afterAim.yaw - preAim.yaw);
          break;
        }
      }
    }
    if (attempt >= 2) throw new Error("avatar kept dying during the stick phases");
    console.log("  (avatar died mid-phase — retrying both phases after respawn)");
  }

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
  await dev.stop();
  process.exit(problems.length ? 1 : 0);
}

await main();
