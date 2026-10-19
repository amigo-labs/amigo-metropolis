// The X1-Alpha's animations, shot headless (fcop-fidelity.md G11): boots a
// solo match with ?debug, freezes the frame loop's own ticking, then drives the
// local mech through the original's button word on the keyboard and steps the
// sim tick by tick (metropolisStep runs the frame loop's own runTick), shooting
// the mech side-on at each pose: the walk, the run, the crouch, a jump in the
// air, the leap, the transform half-way, the hover. Beside each png the
// readout of the original's machine (metropolisRig: walker state, leg track,
// frames) is written, since a picture of a pose does not say which pose.
//
//   bun run verify:x1        # X1_SHOTS_OUT=<dir> to choose where they land

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { launchBrowser, newHarnessContext, ROOT, startDevServer } from "./browserLaunch";

const PORT = Number(process.env.X1_SHOTS_PORT ?? "5183");
const OUT = process.env.X1_SHOTS_OUT ?? join(ROOT, "docs", "verification", "x1-anim");
/** The open debug plain: no walls between the mech and a side-on camera. */
const MAP_ID = process.env.X1_SHOTS_MAP ?? "test-128";

/** The Keyboard preset's keys (input/bindings.ts PRESETS[0][0]). */
const KEY = {
  forward: "Numpad8",
  back: "Numpad5",
  action: "Numpad2",
  jump: "KeyZ",
  target: "Numpad0",
  jinkLeft: "Numpad7",
  jinkRight: "Numpad9",
};

interface Readout {
  ready: boolean;
  legsFrame: number;
  cockpitFrame: number;
  state: number;
  track: number;
  form: number;
}

async function step(page: Page, ticks: number): Promise<void> {
  await page.evaluate((n) => {
    (globalThis as unknown as { metropolisStep: (t: number) => number }).metropolisStep(n);
  }, ticks);
}

async function hold(page: Page, keys: string[], ticks: number): Promise<void> {
  for (const k of keys) await page.keyboard.down(k);
  await step(page, ticks);
  for (const k of keys) await page.keyboard.up(k);
}

/** Puts the local mech back where it stood, still, facing sim +x. */
async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __x1home?: [number, number, number];
      metropolisSim: {
        avatarId: Int32Array;
        ent: {
          posX: Float32Array;
          posY: Float32Array;
          height: Float32Array;
          timerB: Float32Array;
          yaw: Float32Array;
          aimX: Float32Array;
          aimY: Float32Array;
          velX: Float32Array;
          velY: Float32Array;
        };
      };
    };
    const a = w.metropolisSim.avatarId[0];
    const e = w.metropolisSim.ent;
    if (!w.__x1home) w.__x1home = [e.posX[a], e.posY[a], e.height[a]];
    e.posX[a] = w.__x1home[0];
    e.posY[a] = w.__x1home[1];
    e.height[a] = w.__x1home[2];
    e.timerB[a] = 0;
    e.yaw[a] = 0;
    e.aimX[a] = 1;
    e.aimY[a] = 0;
    e.velX[a] = 0;
    e.velY[a] = 0;
  });
}

/** The other mech, out of the shot (test-128 spawns both on one spot) but in lock range. */
async function parkOther(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      metropolisSim: { avatarId: Int32Array; ent: { posX: Float32Array; posY: Float32Array } };
    };
    const a = w.metropolisSim.avatarId[0];
    const b = w.metropolisSim.avatarId[1];
    if (a < 0 || b < 0) return;
    w.metropolisSim.ent.posX[b] = w.metropolisSim.ent.posX[a] + 14;
    w.metropolisSim.ent.posY[b] = w.metropolisSim.ent.posY[a] - 30;
  });
}

async function shoot(page: Page, name: string, side = 1): Promise<Readout> {
  // Side-on, from the mech's left (+z of three for a mech facing sim +x).
  const pose = await page.evaluate(() => {
    const w = globalThis as unknown as {
      metropolisSim: {
        avatarId: Int32Array;
        ent: { posX: Float32Array; posY: Float32Array; height: Float32Array; yaw: Float32Array };
      };
    };
    const id = w.metropolisSim.avatarId[0];
    const e = w.metropolisSim.ent;
    return { x: e.posX[id], y: e.posY[id], h: e.height[id], yaw: e.yaw[id] };
  });
  // Perpendicular to the facing, on the mech's left.
  const lx = -Math.sin(pose.yaw) * side;
  const ly = Math.cos(pose.yaw) * side;
  await page.evaluate(
    (p) => {
      (
        globalThis as unknown as { metropolisSetCamera: (...a: number[]) => boolean }
      ).metropolisSetCamera(...p);
    },
    [pose.x + lx * 4.6, pose.h + 1.0, pose.y + ly * 4.6, pose.x, pose.h + 0.45, pose.y],
  );
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const rig = await page.evaluate(() =>
    (globalThis as unknown as { metropolisRig: () => Readout }).metropolisRig(),
  );
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(rig, null, 1)}\n`);
  console.log(`${name}: ${JSON.stringify(rig)}`);
  return rig;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevServer(PORT);
  const browser = await launchBrowser();
  const context = await newHarnessContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(`${dev.base}/?map=${MAP_ID}&debug&cam=orbit&opponent=idle&fog=off`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await page.waitForFunction(
      () => {
        const w = globalThis as unknown as { metropolisRig?: () => Readout | null };
        return w.metropolisRig?.()?.ready === true;
      },
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      (globalThis as unknown as { metropolisPause: (p: boolean) => void }).metropolisPause(true);
    });
    await page.mouse.click(10, 10);
    await parkOther(page);
    await reset(page);
    await step(page, 10);

    const shots: Record<string, Readout> = {};
    shots.stand = await shoot(page, "x1-stand");
    await hold(page, [KEY.action, KEY.forward], 22);
    await page.keyboard.down(KEY.action);
    await page.keyboard.down(KEY.forward);
    await step(page, 1);
    shots.walk = await shoot(page, "x1-walk");
    await page.keyboard.up(KEY.action);
    await step(page, 14);
    shots.run = await shoot(page, "x1-run");
    await page.keyboard.up(KEY.forward);
    await step(page, 20);
    await reset(page);
    await step(page, 4);
    await page.keyboard.down(KEY.action);
    await page.keyboard.down(KEY.jump);
    await step(page, 12);
    shots.crouch = await shoot(page, "x1-crouch");
    await page.keyboard.up(KEY.jump);
    await page.keyboard.up(KEY.action);
    await step(page, 30);
    await reset(page);
    await step(page, 4);
    // The hop (no step ahead): the jump alone, a few ticks into the air.
    await page.keyboard.down(KEY.jump);
    await step(page, 3);
    await page.keyboard.up(KEY.jump);
    await step(page, 3);
    shots.jump = await shoot(page, "x1-jump");
    await step(page, 40);
    await reset(page);
    await step(page, 4);
    // The leap: the jump while running.
    await page.keyboard.down(KEY.forward);
    await step(page, 18);
    await page.keyboard.down(KEY.jump);
    await step(page, 5);
    await page.keyboard.up(KEY.jump);
    shots.leap = await shoot(page, "x1-leap");
    await page.keyboard.up(KEY.forward);
    await step(page, 45);
    await reset(page);
    await step(page, 4);
    // The transform: the chord, half the ramp's 41 ticks (+ the 2-tick input delay).
    await page.keyboard.down(KEY.target);
    await page.keyboard.down(KEY.action);
    await step(page, 3);
    await page.keyboard.up(KEY.target);
    await page.keyboard.up(KEY.action);
    await step(page, 18);
    shots.transform = await shoot(page, "x1-transform-mid");
    await step(page, 40);
    shots.hover = await shoot(page, "x1-hover");
    writeFileSync(join(OUT, "x1-shots.json"), `${JSON.stringify(shots, null, 1)}\n`);
    // The RE's static rest poses (the greybox buckets' models) at the same
    // camera, for a side-by-side with the rig's frames 0 / 0 and 359 / 29.
    const ref = await context.newPage();
    await ref.goto(`${dev.base}/?map=${MAP_ID}&debug&cam=orbit&opponent=idle&fog=off&x1rig=off`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    await ref.waitForFunction(
      () => !!(globalThis as unknown as { metropolisStep?: unknown }).metropolisStep,
      { timeout: 30000 },
    );
    await ref.waitForTimeout(1500);
    await ref.evaluate(() => {
      (globalThis as unknown as { metropolisPause: (p: boolean) => void }).metropolisPause(true);
    });
    await parkOther(ref);
    await step(ref, 10);
    await shoot(ref, "x1-reference-walker-rest-pose");
    await ref.close();
  } finally {
    await browser.close();
    await dev.stop();
  }
  if (errors.length) console.error(`console/page errors: ${errors.join(" | ")}`);
  console.log(`screenshots: ${OUT}`);
  process.exit(errors.length ? 1 : 0);
}

await main();
