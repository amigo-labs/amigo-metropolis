// The five extra weapons (SimOptions.extraWeapons), shot headless: boots a solo
// match per weapon with ?extra=31 and the loadout on the URL, freezes the frame
// loop, parks the other mech ahead in lock range, fires the weapon through the
// keyboard's button word and steps the sim, then shoots the round (or the
// sphere) from the side.
//
//   bun run verify:weapons    # WEAPON_SHOTS_OUT=<dir> to choose where they land

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { launchBrowser, newHarnessContext, ROOT, startDevServer } from "./browserLaunch";

const PORT = Number(process.env.WEAPON_SHOTS_PORT ?? "5184");
const OUT = process.env.WEAPON_SHOTS_OUT ?? join(ROOT, "docs", "verification", "extra-weapons");
const MAP_ID = process.env.WEAPON_SHOTS_MAP ?? "test-128";

/** The Keyboard preset's fire keys (input/bindings.ts PRESETS[0][0]: 0x20, 0x12, 0x11). */
const KEY = { gun: "Space", heavy: "AltLeft", special: "ControlLeft" };

interface Shot {
  readonly name: string;
  readonly loadout: string;
  readonly key: string;
  /** Ticks the key is held, then ticks stepped before the picture. */
  readonly hold: number;
  readonly after: number;
  /** How far ahead the other mech stands, m. */
  readonly ahead: number;
  /** Power the slot first (its block B). */
  readonly powered?: number;
  /** Frame the newest round, else the mech. */
  readonly round?: boolean;
}

const SHOTS: readonly Shot[] = [
  { name: "riot-shield-up", loadout: "gun=4", key: KEY.gun, hold: 14, after: 0, ahead: 8 },
  { name: "riot-shield", loadout: "gun=4", key: KEY.gun, hold: 14, after: 0, ahead: 2.2 },
  {
    name: "riot-shield-powered",
    loadout: "gun=4",
    key: KEY.gun,
    hold: 14,
    after: 0,
    ahead: 2.6,
    powered: 0,
  },
  {
    name: "k9-drone",
    loadout: "heavy=3",
    key: KEY.heavy,
    hold: 1,
    after: 22,
    ahead: 11,
    round: true,
  },
  {
    name: "fusion-torpedo",
    loadout: "heavy=4",
    key: KEY.heavy,
    hold: 1,
    after: 12,
    ahead: 11,
    round: true,
  },
  {
    name: "grenade-launcher",
    loadout: "special=3",
    key: KEY.special,
    hold: 1,
    after: 10,
    ahead: 7,
    round: true,
  },
  {
    name: "plasma-flare",
    loadout: "special=4",
    key: KEY.special,
    hold: 1,
    after: 14,
    ahead: 10,
    round: true,
  },
];

async function step(page: Page, ticks: number): Promise<void> {
  await page.evaluate((n) => {
    (globalThis as unknown as { metropolisStep: (t: number) => number }).metropolisStep(n);
  }, ticks);
}

interface Sim {
  avatarId: Int32Array;
  powerAmmo: Uint16Array;
  burstLeft: Uint8Array;
  ent: {
    high: number;
    alive: Uint8Array;
    archetype: Uint8Array;
    mode: Uint8Array;
    posX: Float32Array;
    posY: Float32Array;
    height: Float32Array;
    yaw: Float32Array;
    aimX: Float32Array;
    aimY: Float32Array;
  };
}

async function setup(page: Page, ahead: number, powered?: number): Promise<void> {
  await page.evaluate(
    ([d, slot]) => {
      const sim = (globalThis as unknown as { metropolisSim: Sim }).metropolisSim;
      const a = sim.avatarId[0];
      const b = sim.avatarId[1];
      const e = sim.ent;
      e.yaw[a] = 0;
      e.aimX[a] = 1;
      e.aimY[a] = 0;
      if (b >= 0) {
        e.posX[b] = e.posX[a] + d;
        e.posY[b] = e.posY[a];
        e.height[b] = e.height[a];
        e.yaw[b] = Math.PI;
        e.aimX[b] = -1;
        e.aimY[b] = 0;
      }
      if (slot >= 0) {
        sim.powerAmmo[slot] = 200;
        sim.burstLeft[slot] = 1;
      }
    },
    [ahead, powered ?? -1] as [number, number],
  );
}

/** The newest live round's position (three: x, height, z), else the mech's. */
async function subject(page: Page, round: boolean): Promise<[number, number, number]> {
  return page.evaluate((r) => {
    const sim = (globalThis as unknown as { metropolisSim: Sim }).metropolisSim;
    const e = sim.ent;
    let id = sim.avatarId[0];
    if (r) {
      for (let i = e.high - 1; i >= 0; i--) {
        if (e.alive[i] && e.archetype[i] === 6 /* ARCHETYPE.PROJECTILE */) {
          id = i;
          break;
        }
      }
    }
    return [e.posX[id], e.height[id], e.posY[id]] as [number, number, number];
  }, round);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dev = await startDevServer(PORT);
  const browser = await launchBrowser();
  const context = await newHarnessContext(browser);
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  try {
    for (const s of SHOTS) {
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(`${s.name}: ${m.text()}`);
      });
      page.on("pageerror", (e) => errors.push(`${s.name}: ${String(e)}`));
      await page.goto(
        `${dev.base}/?map=${MAP_ID}&debug&cam=orbit&opponent=idle&fog=off&extra=31&${s.loadout}`,
        { waitUntil: "networkidle", timeout: 60000 },
      );
      await page.waitForFunction(
        () => !!(globalThis as unknown as { metropolisStep?: unknown }).metropolisStep,
        { timeout: 30000 },
      );
      await page.waitForTimeout(2500);
      await page.evaluate(() => {
        (globalThis as unknown as { metropolisPause: (p: boolean) => void }).metropolisPause(true);
      });
      await page.mouse.click(10, 10);
      await setup(page, s.ahead, s.powered);
      await step(page, 4);
      await page.keyboard.down(s.key);
      await step(page, s.hold);
      await page.keyboard.up(s.key);
      await step(page, s.after);
      const [x, h, z] = await subject(page, s.round === true);
      // From the mech's left and a little behind and above.
      await page.evaluate(
        (p) => {
          (
            globalThis as unknown as { metropolisSetCamera: (...a: number[]) => boolean }
          ).metropolisSetCamera(...p);
        },
        [x - 2.2, h + 2.4, z + 5.2, x + 0.6, h + 0.4, z],
      );
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(OUT, `${s.name}.png`) });
      out[s.name] = { at: [x, h, z] };
      console.log(`${s.name}: ${JSON.stringify(out[s.name])}`);
      await page.close();
    }
    writeFileSync(join(OUT, "weapon-shots.json"), `${JSON.stringify(out, null, 1)}\n`);
  } finally {
    await browser.close();
    await dev.stop();
  }
  if (errors.length) console.error(`console/page errors: ${errors.join(" | ")}`);
  console.log(`screenshots: ${OUT}`);
  process.exit(errors.length ? 1 : 0);
}

await main();
