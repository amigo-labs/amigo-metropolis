// Close-up verification of the two turret meshes (Standard vs Defense).
// Boots the client, waits for unit GLBs, spawns one of each mode side by side,
// freezes, and shoots mesh + greybox close-ups.
//
//   bun run tools/determinism/src/turretShots.ts
//
// Out: docs/verification/stage7-units/turret-close-{mesh,greybox}.png

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARCHETYPE,
  getMapById,
  TURRET_CAPTURABLE,
  TURRET_DEFENSE,
  worldExtent,
} from "@metropolis/sim";
import { chromium, type Page } from "playwright-core";

const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  join(
    process.env.LOCALAPPDATA ?? "",
    "ms-playwright",
    "chromium-1208",
    "chrome-win64",
    "chrome.exe",
  );
const PORT = Number(process.env.TURRET_SHOTS_PORT ?? "5181");
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", "..", "..");
const CLIENT_DIR = join(ROOT, "packages", "client");
const OUT = process.env.TURRET_SHOTS_OUT ?? join(ROOT, "docs", "verification", "stage7-units");

// Open heightfield so the models read cleanly; no textured terrain needed.
const MAP_ID = "district-01";

function setPaused(page: Page, paused: boolean): Promise<void> {
  return page.evaluate((p) => {
    (globalThis as unknown as { metropolisPause: (v: boolean) => void }).metropolisPause(p);
  }, paused);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  console.log(`starting vite on ${BASE} …`);
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
  // Standard left, Defense right — clear gap, both facing +X (yaw 0).
  const stdX = cx - 3;
  const defX = cx + 3;
  const rowY = cx;

  async function shoot(mode: "mesh" | "greybox", file: string): Promise<string[]> {
    const page = await context.newPage();
    const errors: string[] = [];
    const glbs: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
      if (m.text().includes("[unitMeshes]")) errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("response", (r) => {
      const u = r.url();
      const match = u.match(/\/models\/units\/(turret-[a-z]+)\.glb$/);
      if (match && r.ok()) glbs.push(match[1]);
    });

    const url = `${BASE}/?map=${MAP_ID}&render=${mode}&debug&cam=orbit&fog=off`;
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
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !(glbs.includes("turret-standard") && glbs.includes("turret-defense"))) {
        await page.waitForTimeout(200);
      }
    }

    // Clear map-spawned turrets so only our two models remain, then spawn both.
    await page.evaluate(
      ({ stdX, defX, rowY, arch, modeDef, modeCap }) => {
        const w = globalThis as unknown as {
          metropolisSim: {
            ent: {
              high: number;
              alive: Uint8Array;
              archetype: Uint8Array;
              mode: Uint8Array | Int8Array;
              posX: Float32Array;
              posY: Float32Array;
              height: Float32Array;
              yaw: Float32Array;
              velX: Float32Array;
              velY: Float32Array;
              team: Int8Array;
            };
          };
          metropolisSpawn: (a: number, t: number, x: number, y: number) => number;
        };
        const ent = w.metropolisSim.ent;
        for (let id = 0; id < ent.high; id++) {
          if (ent.alive[id] && ent.archetype[id] === arch.TURRET) {
            ent.alive[id] = 0;
          }
        }
        const idStd = w.metropolisSpawn(arch.TURRET, 0, stdX, rowY);
        const idDef = w.metropolisSpawn(arch.TURRET, 0, defX, rowY);
        if (idStd >= 0) {
          ent.mode[idStd] = modeCap; // Standard mesh
          ent.posX[idStd] = stdX;
          ent.posY[idStd] = rowY;
          ent.height[idStd] = 0;
          ent.yaw[idStd] = 0;
          ent.velX[idStd] = 0;
          ent.velY[idStd] = 0;
          ent.team[idStd] = 0;
        }
        if (idDef >= 0) {
          ent.mode[idDef] = modeDef; // Defense mesh
          ent.posX[idDef] = defX;
          ent.posY[idDef] = rowY;
          ent.height[idDef] = 0;
          ent.yaw[idDef] = 0;
          ent.velX[idDef] = 0;
          ent.velY[idDef] = 0;
          ent.team[idDef] = 0;
        }
        (w as { __turrets?: { std: number; def: number } }).__turrets = {
          std: idStd,
          def: idDef,
        };
      },
      {
        stdX,
        defX,
        rowY,
        arch: ARCHETYPE,
        modeDef: TURRET_DEFENSE,
        modeCap: TURRET_CAPTURABLE,
      },
    );

    await page.waitForTimeout(300);
    await setPaused(page, true);
    await page.evaluate(() => {
      const w = globalThis as unknown as { metropolisSnap: () => void };
      w.metropolisSnap();
    });

    // Eye slightly above + in front, looking at midpoint between the two.
    const midX = (stdX + defX) / 2;
    const eye = [midX, 2.2, rowY + 5.5, midX, 0.8, rowY];
    await page.evaluate((p) => {
      (globalThis as { metropolisSetCamera?: (...a: number[]) => boolean }).metropolisSetCamera?.(
        ...p,
      );
    }, eye);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, file) });

    // Extra: one solo close-up per mode (mesh only).
    if (mode === "mesh") {
      for (const [label, x] of [
        ["standard", stdX],
        ["defense", defX],
      ] as const) {
        const solo = [x, 1.4, rowY + 3.2, x, 0.7, rowY];
        await page.evaluate((p) => {
          (
            globalThis as { metropolisSetCamera?: (...a: number[]) => boolean }
          ).metropolisSetCamera?.(...p);
        }, solo);
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(OUT, `turret-close-${label}.png`) });
      }
    }

    // Report which modes the sim thinks the two entities have.
    const modes = await page.evaluate(({ arch }) => {
      const w = globalThis as unknown as {
        metropolisSim: {
          ent: {
            high: number;
            alive: Uint8Array;
            archetype: Uint8Array;
            mode: Uint8Array | Int8Array;
            posX: Float32Array;
          };
        };
      };
      const out: { id: number; mode: number; x: number }[] = [];
      const ent = w.metropolisSim.ent;
      for (let id = 0; id < ent.high; id++) {
        if (ent.alive[id] && ent.archetype[id] === arch.TURRET) {
          out.push({ id, mode: ent.mode[id], x: ent.posX[id] });
        }
      }
      return out;
    }, { arch: ARCHETYPE });
    console.log(`[${mode}] live turrets:`, modes, "glbs:", glbs);
    if (errors.length) console.warn(`[${mode}] errors:`, errors);

    await page.close();
    return glbs;
  }

  const meshGlbs = await shoot("mesh", "turret-close-mesh.png");
  await shoot("greybox", "turret-close-greybox.png");

  await browser.close();
  dev.kill();

  const ok =
    meshGlbs.includes("turret-standard") && meshGlbs.includes("turret-defense");
  console.log(ok ? "OK: both turret GLBs loaded" : "FAIL: missing turret GLB load");
  console.log(`screenshots → ${OUT}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
