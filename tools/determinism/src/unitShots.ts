// Stage B visual verification (PLAN.md Phase 7 model pass): boots the game
// with the real unit models (?render=mesh), lines up one unit per archetype
// via the ?debug hooks (metropolisSpawn / metropolisPause), and asserts every
// /models/units/<key>.glb loads without falling back to greybox and without
// console/page/asset errors. Shoots the identical greybox lineup too so a
// human can eyeball model↔greybox scale and orientation per archetype.
//
//   bun run verify:units           # from the repo root
//
// Same SwiftShader recipe as arenaShots.ts: no GPU in the dev env, software
// WebGL still exercises the full GLTFLoader → bucket-swap → shader pipeline.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ANIM_HOVER, ARCHETYPE, getMapById, worldExtent } from "@metropolis/sim";
import { chromium, type Page } from "playwright-core";

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.UNIT_SHOTS_PORT ?? "5179");
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", "..", "..");
const CLIENT_DIR = join(ROOT, "packages", "client");
const OUT = process.env.UNIT_SHOTS_OUT ?? join(ROOT, "docs", "verification", "stage7-units");

// Open heightfield arena (no city blocks) so the lineup is legible; the map
// has no textured terrain asset, which is fine — terrain falls back to
// greybox while the unit models still load, and units are what we verify.
// ?warden=1 provides the WARDEN avatar, everything else is spawned.
const MAP_ID = "district-01";
const UNIT_GLBS = [
  "avatar-walker",
  "avatar-hover",
  "runner",
  "guardian",
  "juggernaut",
  "fortress",
  "turret",
  "console",
  "warden",
];

interface ShotResult {
  errors: string[];
  fallbacks: string[];
  badAssets: string[];
  glbsLoaded: string[];
  renderer: string | null;
}

function setPaused(page: Page, paused: boolean): Promise<void> {
  return page.evaluate((p) => {
    (globalThis as unknown as { metropolisPause: (v: boolean) => void }).metropolisPause(p);
  }, paused);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  const extent = worldExtent(getMapById(MAP_ID));
  const cx = extent / 2;

  async function shoot(
    mode: "mesh" | "greybox",
    file: string,
    walkerFile: string,
    hoverFile: string,
  ): Promise<ShotResult> {
    const page = await context.newPage();
    const errors: string[] = [];
    const fallbacks: string[] = [];
    const badAssets: string[] = [];
    const glbsLoaded: string[] = [];
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error") errors.push(t);
      if (t.includes("[unitMeshes]")) fallbacks.push(t);
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("/models/")) {
        if (r.status() >= 400) badAssets.push(`${r.status()} ${u}`);
        const unit = u.match(/\/models\/units\/([a-z-]+)\.glb$/);
        if (unit && r.ok()) glbsLoaded.push(unit[1]);
      }
    });

    const url = `${BASE}/?map=${MAP_ID}&render=${mode}&debug&warden=1&cam=orbit`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForFunction(
      () => {
        const w = globalThis as {
          metropolisSim?: unknown;
          metropolisSetCamera?: unknown;
          metropolisSpawn?: unknown;
          metropolisPause?: unknown;
        };
        return (
          !!w.metropolisSim &&
          typeof w.metropolisSetCamera === "function" &&
          typeof w.metropolisSpawn === "function" &&
          typeof w.metropolisPause === "function"
        );
      },
      { timeout: 15000 },
    );
    if (mode === "mesh") {
      // All nine unit models answered (200) or warned (fallback) before posing.
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && glbsLoaded.length + fallbacks.length < UNIT_GLBS.length) {
        await page.waitForTimeout(200);
      }
    }

    // Lineup: avatar + warden get repositioned, one spawn per remaining
    // archetype. Two rows (team 0 nearer the camera, team 1 behind) around
    // the arena centre. The spawn ids and their grid slots are remembered on
    // globalThis so the units can be snapped back after the settle ticks.
    await page.evaluate(
      ({ cx, arch }) => {
        const w = globalThis as unknown as {
          __lineup?: { id: number; x: number; y: number }[];
          metropolisSim: {
            ent: {
              high: number;
              alive: Uint8Array;
              archetype: Uint8Array;
              team: Int8Array;
            };
          };
          metropolisSpawn: (a: number, t: number, x: number, y: number) => number;
        };
        const ent = w.metropolisSim.ent;
        const rowY = [cx + 4, cx - 8]; // team 0 front row, team 1 back row
        const lineup: { id: number; x: number; y: number }[] = [];
        const put = (id: number, x: number, y: number) => {
          if (id >= 0) lineup.push({ id, x, y });
        };
        // Existing avatars: player 0 walker front-left, warden superplane back.
        for (let id = 0; id < ent.high; id++) {
          if (!ent.alive[id]) continue;
          if (ent.archetype[id] === arch.AVATAR && ent.team[id] === 0) {
            put(id, cx - 16, rowY[0]);
          } else if (ent.archetype[id] === arch.WARDEN) {
            put(id, cx + 17, rowY[1]);
          }
        }
        for (let team = 0; team < 2; team++) {
          const y = rowY[team];
          put(w.metropolisSpawn(arch.RUNNER, team, cx - 12, y), cx - 12, y);
          put(w.metropolisSpawn(arch.GUARDIAN, team, cx - 6, y), cx - 6, y);
          put(w.metropolisSpawn(arch.JUGGERNAUT, team, cx, y), cx, y);
          put(w.metropolisSpawn(arch.FORTRESS, team, cx + 7, y), cx + 7, y);
        }
        // Neutral-capturable statics, one each (team tint path is the same).
        put(w.metropolisSpawn(arch.TURRET, 0, cx + 13, rowY[0]), cx + 13, rowY[0]);
        put(w.metropolisSpawn(arch.CONSOLE, 1, cx + 13, rowY[1]), cx + 13, rowY[1]);
        w.__lineup = lineup;
      },
      { cx, arch: ARCHETYPE },
    );

    // A few ticks so flyers take their altitude, then FREEZE, snap everything
    // onto the grid facing yaw=0 (sim +X = image right for this camera —
    // greybox and models must agree), and re-snapshot the posed scene. With
    // the sim frozen nothing re-aims, so the pose is exact.
    await page.waitForTimeout(400);
    await setPaused(page, true);
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __lineup?: { id: number; x: number; y: number }[];
        metropolisSim: {
          ent: {
            alive: Uint8Array;
            posX: Float32Array;
            posY: Float32Array;
            yaw: Float32Array;
            velX: Float32Array;
            velY: Float32Array;
          };
        };
        metropolisSnap: () => void;
      };
      const ent = w.metropolisSim.ent;
      for (const u of w.__lineup ?? []) {
        if (!ent.alive[u.id]) continue;
        ent.posX[u.id] = u.x;
        ent.posY[u.id] = u.y;
        ent.yaw[u.id] = 0;
        ent.velX[u.id] = 0;
        ent.velY[u.id] = 0;
      }
      w.metropolisSnap();
    });

    const pose = [cx, 13, cx + 27, cx, 2, cx + 2];
    const placed = await page.evaluate((p) => {
      const w = globalThis as { metropolisSetCamera?: (...a: number[]) => boolean };
      return w.metropolisSetCamera?.(...p) ?? false;
    }, pose);
    if (!placed) errors.push("metropolisSetCamera returned false (no view)");
    await page.waitForTimeout(500);

    const renderer = await page.evaluate(() => {
      interface Gl {
        getExtension(name: string): { readonly UNMASKED_RENDERER_WEBGL: number } | null;
        getParameter(pname: number): unknown;
        readonly RENDERER: number;
      }
      interface Canvas {
        getContext(type: string): Gl | null;
      }
      const doc = globalThis as unknown as { document: { createElement(t: string): Canvas } };
      const gl = doc.document.createElement("canvas").getContext("webgl2");
      if (!gl) return null;
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      return String(
        ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      );
    });

    await page.screenshot({ path: join(OUT, file) });

    // Close-up on the avatar walker (facing must read against the greybox
    // mech: +X, image right, from this pose).
    const avatarPose = [cx - 16, 4, cx + 12, cx - 16, 1.2, cx + 4];
    await page.evaluate((p) => {
      const w = globalThis as { metropolisSetCamera?: (...a: number[]) => boolean };
      return w.metropolisSetCamera?.(...p) ?? false;
    }, avatarPose);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, walkerFile) });

    // Second visual state of the avatar: hover. While frozen, flip the
    // renderer-facing ANIM_HOVER bit directly and re-snapshot — the frame
    // loop routes the avatar into the avatar-hover bucket via bucketFor.
    await page.evaluate(
      ({ arch, hover }) => {
        const w = globalThis as unknown as {
          metropolisSim: {
            ent: { high: number; alive: Uint8Array; archetype: Uint8Array; animState: Uint8Array };
          };
          metropolisSnap: () => void;
        };
        const ent = w.metropolisSim.ent;
        for (let id = 0; id < ent.high; id++) {
          if (ent.alive[id] && ent.archetype[id] === arch.AVATAR) ent.animState[id] |= hover;
        }
        w.metropolisSnap();
      },
      { arch: ARCHETYPE, hover: ANIM_HOVER },
    );
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(OUT, hoverFile) });

    await page.close();
    return { errors, fallbacks, badAssets, glbsLoaded, renderer };
  }

  const mesh = await shoot(
    "mesh",
    "units-mesh.png",
    "units-mesh-walker.png",
    "units-mesh-hover.png",
  );
  await shoot(
    "greybox",
    "units-greybox.png",
    "units-greybox-walker.png",
    "units-greybox-hover.png",
  );

  const problems: string[] = [];
  if (mesh.renderer === null) problems.push("no WebGL2 context");
  if (mesh.fallbacks.length) problems.push(`greybox fallbacks: ${mesh.fallbacks.join(" | ")}`);
  const missing = UNIT_GLBS.filter((k) => !mesh.glbsLoaded.includes(k));
  if (missing.length) problems.push(`unit glbs never returned 200: ${missing.join(", ")}`);
  if (mesh.badAssets.length) problems.push(`asset errors: ${mesh.badAssets.join(", ")}`);
  if (mesh.errors.length) problems.push(`console/page errors: ${mesh.errors.join(" | ")}`);

  if (problems.length) {
    console.error(`FAIL units: ${problems.join("; ")}`);
  } else {
    console.log("OK   units: all unit models loaded, no fallback, no errors");
  }
  console.log(`\nWebGL renderer: ${mesh.renderer ?? "unavailable"}`);
  console.log(`screenshots: ${OUT}`);

  await browser.close();
  dev.kill();
  await dev.exited;
  process.exit(problems.length ? 1 : 0);
}

await main();
