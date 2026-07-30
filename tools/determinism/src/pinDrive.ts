// Agent-driven verification: a long-lived headless client an agent can steer.
//
//   bun run pin:drive                     # boot, then serve commands on :8788
//   bun run pin:drive reshoot latest      # re-shoot a pin's exact camera pose
//   bun run pin:drive --selftest          # boot, goto → fly → pin, assert, exit
//
// Why HTTP and not stdin: an agent invokes a shell per step, so a long-lived
// stdin process would need FIFO plumbing. With a control server it starts this
// once in the background and then makes cheap synchronous calls, while the page
// (and its sim) stays alive across all of them.
//
// The pins it writes go through the same pinStore as the human's, and the
// capture itself runs the client's own metropolisPin — so a reshoot is
// field-for-field comparable with the pin that prompted it.
//
// Loopback only. Debug tooling — not production.

import { join } from "node:path";
import { getMapById } from "@metropolis/sim";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  collectDiagnostics,
  launchBrowser,
  newHarnessContext,
  type PageDiagnostics,
  ROOT,
  startDevServer,
  waitForHooks,
} from "./browserLaunch";
import { servePinReceiver } from "./pinReceiver";
import { createPinStore } from "./pinStore";

const PORT = Number(process.env.PIN_DRIVE_PORT ?? "5182");
const CONTROL_PORT = Number(process.env.PIN_DRIVE_CONTROL_PORT ?? "8788");
// Its own receiver, on its own port: an unattended run cannot assume someone
// started `pin:serve`, and a headless browser has nowhere to put the download
// fallback. The client is pointed here via ?pinServer=.
const RECEIVER_PORT = Number(process.env.PIN_DRIVE_RECEIVER_PORT ?? "8789");
const RECEIVER_URL = `http://127.0.0.1:${RECEIVER_PORT}`;
const BASE = `http://127.0.0.1:${PORT}`;
const PINS = join(ROOT, "docs", "verification", "pins");
const store = createPinStore(PINS);

/** Default arena when a `goto` names none. */
const DEFAULT_MAP = "urban-jungle";

interface Session {
  readonly context: BrowserContext;
  page: Page | null;
  diag: PageDiagnostics | null;
  url: string | null;
}

type Args = Record<string, unknown>;

const num = (args: Args, key: string, fallback: number): number => {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
const str = (args: Args, key: string, fallback: string): string => {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
};

/**
 * Opens the client in fly mode with the debug hooks armed. Every verb below
 * needs a page, and the pin hooks only exist under ?debug + ?cam=fly.
 */
async function goto(session: Session, args: Args): Promise<unknown> {
  const map = str(args, "map", DEFAULT_MAP);
  const render = str(args, "render", "mesh");
  const seed = args.seed === undefined ? null : num(args, "seed", 0);
  const warden = args.warden === undefined ? null : num(args, "warden", 0);
  const fog = str(args, "fog", "off");

  const params = new URLSearchParams({ map, render, cam: "fly", play: "1", fog });
  params.set("debug", "");
  params.set("pinServer", RECEIVER_URL);
  if (seed !== null) params.set("seed", String(seed));
  if (warden !== null) params.set("warden", String(warden));
  const url = `${BASE}/?${params.toString()}`;

  if (session.page) await session.page.close();
  const page = await session.context.newPage();
  session.page = page;
  session.diag = collectDiagnostics(page, { glbFor: map });
  session.url = url;
  await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
  await waitForHooks(page, ["metropolisSim", "metropolisPin", "metropolisFly"]);
  // Freeze immediately: an agent posing a camera does not want the match
  // running underneath it between two commands.
  await page.evaluate(() => {
    (globalThis as unknown as { metropolisPause: (v: boolean) => void }).metropolisPause(true);
  });
  return { url, map, render, seed, warden };
}

function requirePage(session: Session): Page {
  if (!session.page) throw new Error("no page — run `goto` first");
  return session.page;
}

// Uniform (session, args) shape so the control server can dispatch by name.
// Verbs that read nothing out of args just ignore it.
const VERBS: Record<string, (session: Session, args: Args) => Promise<unknown>> = {
  goto,

  async fly(session, args) {
    const page = requirePage(session);
    const placed = await page.evaluate(
      (p: number[]) =>
        (
          globalThis as unknown as {
            metropolisFly: (x: number, y: number, z: number, yaw: number, pitch: number) => boolean;
          }
        ).metropolisFly(p[0], p[1], p[2], p[3], p[4]),
      [
        num(args, "x", 0),
        num(args, "y", 40),
        num(args, "z", 0),
        num(args, "yaw", 0),
        num(args, "pitch", -0.6),
      ],
    );
    if (!placed) throw new Error("metropolisFly returned false (no view, or not ?cam=fly)");
    return { placed };
  },

  async spawn(session, args) {
    const page = requirePage(session);
    const id = await page.evaluate(
      (p: number[]) =>
        (
          globalThis as unknown as {
            metropolisSpawn: (a: number, t: number, x: number, y: number) => number;
          }
        ).metropolisSpawn(p[0], p[1], p[2], p[3]),
      [num(args, "archetype", 1), num(args, "team", 0), num(args, "x", 0), num(args, "y", 0)],
    );
    return { id };
  },

  async pause(session, args) {
    const page = requirePage(session);
    const on = args.on === undefined ? true : args.on === true;
    await page.evaluate((v: boolean) => {
      (globalThis as unknown as { metropolisPause: (p: boolean) => void }).metropolisPause(v);
    }, on);
    return { paused: on };
  },

  async step(session, args) {
    const page = requirePage(session);
    const tick = await page.evaluate(
      (n: number) =>
        (globalThis as unknown as { metropolisStep: (t: number) => number }).metropolisStep(n),
      Math.max(0, Math.trunc(num(args, "ticks", 1))),
    );
    return { tick };
  },

  /** Current sim tick. The page starts ticking before `goto` can freeze it. */
  async tick(session) {
    const page = requirePage(session);
    return {
      tick: await page.evaluate(
        () => (globalThis as unknown as { metropolisSim: { tick: number } }).metropolisSim.tick,
      ),
    };
  },

  async snap(session) {
    const page = requirePage(session);
    await page.evaluate(() => {
      (globalThis as unknown as { metropolisSnap: () => void }).metropolisSnap();
    });
    return { ok: true };
  },

  async hud(session) {
    const page = requirePage(session);
    return {
      hud: await page.evaluate(() =>
        (globalThis as unknown as { metropolisHud: () => string[] }).metropolisHud(),
      ),
    };
  },

  async state(session, args) {
    const page = requirePage(session);
    const entities = await page.evaluate(
      (p: number[]) =>
        (
          globalThis as unknown as {
            metropolisState: (cx: number, cz: number, r?: number) => unknown[];
          }
        ).metropolisState(p[0], p[1], p[2]),
      [num(args, "x", 0), num(args, "z", 0), num(args, "radius", 60)],
    );
    return { entities };
  },

  // The whole point: the agent takes a pin through the client's own capture
  // path, so what lands on disk is what the human's P key produces.
  async pin(session, args) {
    const page = requirePage(session);
    const result = await page.evaluate(
      (p: { notes: string; parentId: string | null }) =>
        (
          globalThis as unknown as {
            metropolisPin: (o: {
              notes: string;
              parentId: string | null;
            }) => Promise<{ id: string; message: string }>;
          }
        ).metropolisPin(p),
      { notes: str(args, "notes", ""), parentId: (args.parentId as string | null) ?? null },
    );
    return result;
  },

  /** Raw page screenshot, for a quick look without minting a pin. */
  async shot(session, args) {
    const page = requirePage(session);
    const name = str(args, "name", "shot").replace(/[^a-zA-Z0-9._-]/g, "");
    const path = join(PINS, "latest", `${name}.png`);
    await page.screenshot({ path });
    return { path };
  },

  /** Console/asset problems seen on the current page since `goto`. */
  async diagnostics(session) {
    const diag = session.diag;
    if (!diag) throw new Error("no page — run `goto` first");
    return {
      errors: diag.errors,
      badAssets: diag.badAssets,
      greyboxFallback: diag.fallback(),
      glbLoaded: diag.glbLoaded(),
    };
  },
};

interface PinLike {
  mapId?: unknown;
  render?: unknown;
  seed?: unknown;
  tick?: unknown;
  camera?: { x?: unknown; y?: unknown; z?: unknown; yaw?: unknown; pitch?: unknown };
  reproduction?: unknown;
  notes?: unknown;
}

/**
 * Re-shoots a stored pin: same arena, seed and render mode, fast-forwarded to
 * the same tick, camera put back on the recorded pose, then a fresh pin whose
 * parentId points at the original.
 *
 * Honest about its limits — see PinReproduction in pinTypes.ts. `static` pins
 * (nothing movable in frame) reproduce exactly and are a real before/after;
 * `approximate` ones re-run a *fresh* sim, so terrain and placement match but
 * the units do not.
 */
async function reshoot(session: Session, idOrLatest: string): Promise<unknown> {
  const id = store.resolveId(idOrLatest);
  if (!id) throw new Error(`no such pin: ${idOrLatest}`);
  const pin = store.readPin(id) as PinLike | null;
  if (!pin) throw new Error(`pin ${id} has no readable pin.json`);

  const cam = pin.camera ?? {};
  const asNum = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  await goto(session, {
    map: typeof pin.mapId === "string" ? pin.mapId : DEFAULT_MAP,
    render: typeof pin.render === "string" ? pin.render : "mesh",
    ...(typeof pin.seed === "number" ? { seed: pin.seed } : {}),
  });

  // Step the *difference*, not the target: the page's rAF loop gets a few ticks
  // in before `goto` can freeze it, so stepping `pin.tick` would overshoot.
  const targetTick = asNum(pin.tick, 0);
  const { tick: bootTick } = (await VERBS.tick(session, {})) as { tick: number };
  let reachedTick = bootTick;
  if (targetTick > bootTick) {
    const stepped = (await VERBS.step(session, { ticks: targetTick - bootTick })) as {
      tick: number;
    };
    reachedTick = stepped.tick;
  }
  await VERBS.snap(session, {});
  await VERBS.fly(session, {
    x: asNum(cam.x, 0),
    y: asNum(cam.y, 40),
    z: asNum(cam.z, 0),
    yaw: asNum(cam.yaw, 0),
    pitch: asNum(cam.pitch, -0.6),
  });

  const notes = typeof pin.notes === "string" ? pin.notes : "";
  const shot = (await VERBS.pin(session, {
    notes: `Reshoot of ${id}. Original problem: ${notes || "(none recorded)"}`,
    parentId: id,
  })) as { id: string; message: string };

  const reproduction = typeof pin.reproduction === "string" ? pin.reproduction : "unknown";
  const warnings: string[] = [];
  if (reproduction === "approximate") {
    warnings.push(
      "reproduction=approximate: live entities were in the original frame. Terrain " +
        "and placement are reproduced exactly; the units are NOT (no replay was " +
        "recorded). Treat this as evidence for static geometry only.",
    );
  }
  // The page ticks a little during load, so a pin taken in the first second of a
  // match cannot be rewound to. Say so instead of implying the ticks matched.
  if (reachedTick !== targetTick) {
    warnings.push(
      `tick ${targetTick} was not reachable — the client had already ticked to ` +
        `${bootTick} during page load, so this shot is at tick ${reachedTick}. ` +
        "Static geometry is unaffected.",
    );
  }
  return {
    parentId: id,
    id: shot.id,
    reproduction,
    targetTick,
    reachedTick,
    before: `docs/verification/pins/${id}`,
    after: `docs/verification/pins/${shot.id}`,
    warnings,
  };
}

// --- control server ----------------------------------------------------------

// Deliberately NO CORS header. This endpoint spawns pages, steps the sim and
// writes files; with Access-Control-Allow-Origin: * any site open in the user's
// browser could read its responses while pin:drive is running. The only client
// is pinCmd.ts, a Bun script, which is not subject to CORS at all.
// (pinReceiver.ts is the opposite case and does need it — see the note there.)
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function serveControl(session: Session): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return json({ ok: true, verbs: Object.keys(VERBS).concat("reshoot"), page: session.url });
      }
      if (req.method !== "POST" || url.pathname !== "/cmd") {
        return json({ error: "POST /cmd { verb, args }" }, 404);
      }
      let body: { verb?: string; args?: Args };
      try {
        body = (await req.json()) as { verb?: string; args?: Args };
      } catch (e) {
        return json({ error: `bad JSON: ${e instanceof Error ? e.message : String(e)}` }, 400);
      }
      const verb = body.verb ?? "";
      const args = body.args ?? {};
      try {
        if (verb === "reshoot") {
          return json({ ok: true, result: await reshoot(session, str(args, "id", "latest")) });
        }
        const fn = VERBS[verb];
        if (!fn) {
          return json({ error: `unknown verb: ${verb}`, verbs: Object.keys(VERBS) }, 400);
        }
        return json({ ok: true, result: await fn(session, args) });
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
  });
  return { port: server.port ?? CONTROL_PORT, stop: () => server.stop(true) };
}

// --- selftest ----------------------------------------------------------------

/**
 * Boots, drives goto → fly → pin, and asserts a pin actually landed with a
 * non-empty screenshot and decoded entities. Not in CI: ci.yml deliberately has
 * no browser step, and this needs Chromium plus a vite server.
 */
async function selftest(session: Session): Promise<boolean> {
  const problems: string[] = [];
  await goto(session, { map: DEFAULT_MAP, render: "mesh" });

  // Aim at the arena's own content rather than a literal pose: over the apron
  // both shots are empty grey, so a rendering regression would sail through.
  const map = getMapById(DEFAULT_MAP);
  const pts = [...map.turretSpots, ...map.basePlots.map((b) => ({ x: b.x, y: b.y }))];
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const cz = pts.reduce((a, p) => a + p.y, 0) / pts.length;

  // Spawn on that centroid so `entities` is exercised and lands in frame.
  const spawned = (await VERBS.spawn(session, {
    archetype: 1,
    team: 0,
    x: cx,
    y: cz,
  })) as { id: number };
  if (spawned.id < 0) problems.push("metropolisSpawn returned a negative id");
  await VERBS.snap(session, {});
  // Stand back and look down at the centroid: yaw 0 faces -Z, so sit at +Z.
  await VERBS.fly(session, { x: cx, y: 46, z: cz + 42, yaw: 0, pitch: -0.6 });

  const shot = (await VERBS.pin(session, { notes: "pin:drive --selftest" })) as { id: string };
  const pin = store.readPin(shot.id) as {
    shots?: unknown[];
    entities?: unknown[];
    version?: unknown;
  } | null;
  if (!pin) problems.push(`pin ${shot.id} was not written`);
  else {
    if (pin.version !== 2) problems.push(`expected pin version 2, got ${String(pin.version)}`);
    if (!Array.isArray(pin.shots) || pin.shots.length < 2) {
      problems.push("expected both view.png and top.png in shots[]");
    }
    if (!Array.isArray(pin.entities) || pin.entities.length === 0) {
      problems.push("expected at least the spawned unit in entities[]");
    }
    const file = Bun.file(join(PINS, shot.id, "view.png"));
    if ((await file.exists()) === false) problems.push("view.png missing on disk");
    else if (file.size < 1024) problems.push(`view.png suspiciously small (${file.size} bytes)`);
    const top = Bun.file(join(PINS, shot.id, "top.png"));
    if ((await top.exists()) === false) problems.push("top.png missing on disk");
  }

  const diag = session.diag;
  if (diag && diag.errors.length > 0) problems.push(`console errors: ${diag.errors.join(" | ")}`);

  if (problems.length > 0) {
    for (const p of problems) console.error(`FAIL ${p}`);
    return false;
  }
  console.log(`OK   pin:drive selftest — pin ${shot.id} written with both shots and entities`);
  return true;
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const wantSelftest = argv.includes("--selftest");
  const reshootIdx = argv.indexOf("reshoot");
  const wantReshoot = reshootIdx >= 0;

  const receiver = servePinReceiver(store, RECEIVER_PORT);
  console.log(`[pin:drive] pin receiver on ${RECEIVER_URL} → ${PINS}`);
  const dev = await startDevServer(PORT);
  const browser: Browser = await launchBrowser();
  const context = await newHarnessContext(browser);
  const session: Session = { context, page: null, diag: null, url: null };

  const shutdown = async (code: number): Promise<never> => {
    await browser.close();
    await dev.stop();
    receiver.stop(true);
    process.exit(code);
  };

  if (wantSelftest) {
    let ok = false;
    try {
      ok = await selftest(session);
    } catch (e) {
      console.error(`FAIL selftest threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    await shutdown(ok ? 0 : 1);
  }

  if (wantReshoot) {
    try {
      const result = await reshoot(session, argv[reshootIdx + 1] ?? "latest");
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(`reshoot failed: ${e instanceof Error ? e.message : String(e)}`);
      await shutdown(1);
    }
    await shutdown(0);
  }

  const control = serveControl(session);
  console.log(`[pin:drive] control server on http://127.0.0.1:${control.port}`);
  console.log(`[pin:drive] client on ${BASE}`);
  console.log('[pin:drive] POST /cmd {"verb":"goto","args":{"map":"la-cantina"}}');
  console.log('[pin:drive] or: bun run pin:cmd goto \'{"map":"la-cantina"}\'');
  const onSignal = (): void => {
    control.stop();
    void shutdown(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

await main();
