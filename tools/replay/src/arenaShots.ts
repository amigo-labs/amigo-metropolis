// Stage 4 visual verification (PLAN.md Phase 10): renders every textured arena
// mesh (?render=mesh) in a real browser with a live rAF loop and asserts it
// loads without falling back to greybox and without console/page/asset errors.
// For each arena it also shoots the matching greybox view from the identical
// camera so a human can eyeball mesh↔greybox alignment (base/marker positions).
//
//   bun run verify:arenas          # from the repo root
//
// The dev env has no GPU, so Chromium renders WebGL through SwiftShader
// (software). That still exercises the full GLTFLoader → material → shader
// pipeline and catches asset 404s, GLTF parse failures, gross misalignment and
// missing upper decks — everything except hardware-driver-specific quirks.
//
// Requires a Chromium binary (default /opt/pw-browsers/chromium, override with
// CHROMIUM_PATH) and vite (client dev server, spawned here on ARENA_SHOTS_PORT).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getMapById, worldExtent } from "@metropolis/sim";
import { chromium } from "playwright-core";

const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const PORT = Number(process.env.ARENA_SHOTS_PORT ?? "5178");
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(import.meta.dir, "..", "..", "..");
const CLIENT_DIR = join(ROOT, "packages", "client");
const OUT = process.env.ARENA_SHOTS_OUT ?? join(ROOT, "docs", "verification", "stage4-arenas");

// The six arenas in the picker, each with a committed .glb under
// packages/client/public/models/<id>/. venice-beach is the layered (multi-deck)
// arena the DoD calls out for an explicit deck check.
const ARENAS = [
  "urban-jungle",
  "proving-ground",
  "la-cantina",
  "bug-hunt",
  "hollywood-keys",
  "venice-beach",
] as const;
const LAYERED = "venice-beach";
// ARENA_SHOTS_ONLY=urban-jungle,hollywood-keys narrows the run for fast iteration.
const ONLY = (process.env.ARENA_SHOTS_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type Pose = [number, number, number, number, number, number];

/** Elevated diagonal overview that frames the whole arena, scaled to extent. */
function overviewPose(extent: number): Pose {
  const c = extent / 2;
  return [c + extent * 0.62, extent * 0.85, c + extent * 0.62, c, extent * 0.04, c];
}

/** Lower, angled view that shows vertical structure (upper decks) side-on. */
function deckPose(extent: number): Pose {
  const c = extent / 2;
  return [c - extent * 0.1, extent * 0.42, c - extent * 0.72, c, extent * 0.14, c];
}

interface ShotResult {
  errors: string[];
  fallback: boolean;
  badAssets: string[];
  glbLoaded: boolean;
  renderer: string | null;
}

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(stepMs);
  }
  return pred();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // --- dev server -----------------------------------------------------------
  console.log(`starting vite dev server on ${BASE} …`);
  const dev = Bun.spawn(
    ["bun", "x", "vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: CLIENT_DIR, stdout: "ignore", stderr: "inherit", env: { ...process.env } },
  );
  // Poll readiness explicitly (fetch is async, so a sync predicate can't await
  // it): up to ~60s of 500ms probes against the dev server root.
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

  // --- browser --------------------------------------------------------------
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

  async function shoot(
    id: string,
    mode: "mesh" | "greybox",
    pose: Pose,
    file: string,
  ): Promise<ShotResult> {
    const page = await context.newPage();
    const errors: string[] = [];
    const badAssets: string[] = [];
    let fallback = false;
    let glbLoaded = false;
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error") errors.push(t);
      if (t.includes("[meshMap] no mesh asset")) fallback = true;
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("/models/")) {
        if (r.status() >= 400) badAssets.push(`${r.status()} ${u}`);
        if (u.endsWith(`/models/${id}/${id}.glb`) && r.ok()) glbLoaded = true;
      }
    });

    const url = `${BASE}/?map=${id}&render=${mode}&debug&cam=orbit`;
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForFunction(
      () => {
        const w = globalThis as { metropolisSim?: unknown; metropolisSetCamera?: unknown };
        return !!w.metropolisSim && typeof w.metropolisSetCamera === "function";
      },
      { timeout: 15000 },
    );
    if (mode === "mesh") await waitFor(() => glbLoaded || fallback, 15000);

    const placed = await page.evaluate((p) => {
      const w = globalThis as { metropolisSetCamera?: (...a: number[]) => boolean };
      return w.metropolisSetCamera?.(...p) ?? false;
    }, pose);
    if (!placed) errors.push("metropolisSetCamera returned false (no view)");
    await page.waitForTimeout(500);

    // Confirms SwiftShader/ANGLE actually gave the page a WebGL2 context (null
    // ⇒ software GL missing ⇒ nothing rendered). DOM types aren't in this
    // package's lib, so the browser globals are typed locally.
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
    await page.close();
    return { errors, fallback, badAssets, glbLoaded, renderer };
  }

  // --- run --------------------------------------------------------------------
  let ok = true;
  let rendererSeen: string | null = null;
  for (const id of ARENAS) {
    if (ONLY.length && !ONLY.includes(id)) continue;
    const extent = worldExtent(getMapById(id));
    const over = overviewPose(extent);

    const mesh = await shoot(id, "mesh", over, `${id}-mesh.png`);
    await shoot(id, "greybox", over, `${id}-greybox.png`);
    if (id === LAYERED) await shoot(id, "mesh", deckPose(extent), `${id}-mesh-decks.png`);

    rendererSeen ??= mesh.renderer;
    const problems: string[] = [];
    if (mesh.renderer === null) problems.push("no WebGL2 context");
    if (mesh.fallback) problems.push("fell back to greybox (mesh asset failed to load)");
    if (!mesh.glbLoaded) problems.push("glb never returned 200");
    if (mesh.badAssets.length) problems.push(`asset errors: ${mesh.badAssets.join(", ")}`);
    if (mesh.errors.length) problems.push(`console/page errors: ${mesh.errors.join(" | ")}`);

    if (problems.length) {
      ok = false;
      console.error(`FAIL ${id}: ${problems.join("; ")}`);
    } else {
      console.log(`OK   ${id}: textured mesh loaded, no fallback, no errors`);
    }
  }

  console.log(`\nWebGL renderer: ${rendererSeen ?? "unavailable"}`);
  console.log(`screenshots: ${OUT}`);

  await browser.close();
  dev.kill();
  await dev.exited;
  process.exit(ok ? 0 : 1);
}

await main();
