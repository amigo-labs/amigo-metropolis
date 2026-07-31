// Shared boot for every browser-based verification harness: spawn vite, wait
// for it, launch headless Chromium over SwiftShader, and wire the page
// collectors that turn "it rendered" into a machine-checkable verdict.
//
// This existed four times over (arenaShots, unitShots, touchInput, turretShots)
// before pinDrive would have made five. The SwiftShader argument set in
// particular is the kind of thing that gets fixed in one copy and stays broken
// in three.
//
// The dev env has no GPU, so WebGL goes through SwiftShader (software). That
// still exercises the full GLTFLoader → material → shader pipeline and catches
// asset 404s, glTF parse failures, gross misalignment and missing decks —
// everything except hardware-driver-specific quirks.

import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

/** Default Chromium in this image; override with CHROMIUM_PATH. */
export const CHROMIUM_DEFAULT = "/opt/pw-browsers/chromium";
export const ROOT = join(import.meta.dir, "..", "..", "..");
export const CLIENT_DIR = join(ROOT, "packages", "client");

/** Software-GL flags. All four harnesses used exactly this set. */
const SWIFTSHADER_ARGS = [
  "--no-sandbox",
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

export interface DevServer {
  readonly base: string;
  readonly stop: () => Promise<void>;
}

/**
 * Spawns the client dev server and polls its root until it answers (up to ~60s
 * of 500ms probes — fetch is async, so a sync predicate cannot await it).
 * Exits the process on failure, which is what every caller did by hand.
 */
export async function startDevServer(port: number): Promise<DevServer> {
  const base = `http://127.0.0.1:${port}`;
  console.log(`starting vite dev server on ${base} …`);
  const dev = Bun.spawn(
    ["bun", "x", "vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: CLIENT_DIR, stdout: "ignore", stderr: "inherit", env: { ...process.env } },
  );
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    ready = await fetch(base)
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
  return {
    base,
    stop: async () => {
      dev.kill();
      await dev.exited;
    },
  };
}

export async function launchBrowser(): Promise<Browser> {
  return await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? CHROMIUM_DEFAULT,
    headless: true,
    args: SWIFTSHADER_ARGS,
  });
}

export interface HarnessContextOptions {
  readonly width?: number;
  readonly height?: number;
  /** Phone-shaped touch context (touchInput). */
  readonly touch?: boolean;
}

export async function newHarnessContext(
  browser: Browser,
  opts: HarnessContextOptions = {},
): Promise<BrowserContext> {
  const viewport = { width: opts.width ?? 1280, height: opts.height ?? 800 };
  return opts.touch
    ? await browser.newContext({ viewport, hasTouch: true, isMobile: true })
    : await browser.newContext({ viewport });
}

/**
 * What went wrong on a page, collected as it happens. `fallback` and `glbLoaded`
 * are the two signals that separate "the arena rendered" from "the arena
 * silently rendered as greybox", which a screenshot alone cannot tell you.
 */
export interface PageDiagnostics {
  readonly errors: string[];
  readonly badAssets: string[];
  readonly fallback: () => boolean;
  readonly glbLoaded: () => boolean;
}

export interface DiagnosticsOptions {
  /** Map id whose /models/<id>/<id>.glb must return 200 for glbLoaded. */
  readonly glbFor?: string;
  /** Substring marking a greybox fallback; defaults to the meshMap warning. */
  readonly fallbackMarker?: string;
}

export function collectDiagnostics(page: Page, opts: DiagnosticsOptions = {}): PageDiagnostics {
  const marker = opts.fallbackMarker ?? "[meshMap] no mesh asset";
  const errors: string[] = [];
  const badAssets: string[] = [];
  let fallback = false;
  let glbLoaded = false;
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error") errors.push(t);
    if (t.includes(marker)) fallback = true;
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("response", (r) => {
    const u = r.url();
    if (!u.includes("/models/")) return;
    if (r.status() >= 400) badAssets.push(`${r.status()} ${u}`);
    if (opts.glbFor && u.endsWith(`/models/${opts.glbFor}/${opts.glbFor}.glb`) && r.ok()) {
      glbLoaded = true;
    }
  });
  return { errors, badAssets, fallback: () => fallback, glbLoaded: () => glbLoaded };
}

/**
 * Confirms SwiftShader/ANGLE actually gave the page a WebGL2 context — null
 * means software GL is missing and nothing rendered at all. DOM types are not
 * in this package's lib, so the browser globals are typed locally.
 */
export async function webglRenderer(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
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
}

/** Waits until the named ?debug hooks are installed on the page. */
export async function waitForHooks(
  page: Page,
  names: readonly string[],
  timeout = 15000,
): Promise<void> {
  await page.waitForFunction(
    (hooks: string[]) => {
      const w = globalThis as unknown as Record<string, unknown>;
      return hooks.every((h) => w[h] !== undefined && w[h] !== null);
    },
    names as string[],
    { timeout },
  );
}

/** Polls a predicate that flips from a page event listener. */
export async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(100);
  }
  return pred();
}
