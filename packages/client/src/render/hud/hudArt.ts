// The HUD's atlas pages (public/hud, `bun run gen:presentation`): GlblData's
// Cbmp page 11 — the weapon icons, the FUTURE COP badge, the radar disc — and the
// six missions' lock reticles. Loaded once per page; the HUD checks `ready`
// and redraws once they are in.

export interface HudImage {
  ready: boolean;
  readonly image: HTMLImageElement;
}

const cache = new Map<string, HudImage>();

function load(url: string): HudImage {
  const have = cache.get(url);
  if (have) return have;
  const image = new Image();
  const entry: HudImage = { ready: false, image };
  image.onload = () => {
    entry.ready = true;
  };
  image.src = url;
  cache.set(url, entry);
  return entry;
}

/** GlblData's page 11 (tex11.png), black keyed transparent. */
export function hudPage11(): HudImage {
  return load("/hud/tex11.png");
}

/** The lock reticles, 16 x 16 each, one column per arena (ARENA_PRESENTATION.reticle). */
export function hudReticles(): HudImage {
  return load("/hud/reticles.png");
}
