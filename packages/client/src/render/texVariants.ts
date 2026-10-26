// Texture-variant switcher for the textured map render path (?render=mesh): the
// player's Textures option (Classic / HD) and the debug hotkeys.
//
// The atlas pipeline (RE-repo tools/gfx/atlas_repack.py) emits several atlas
// PNGs per map that share ONE pack layout — identical UVs, interchangeable
// pixels: atlas-original.png (source texels nearest-x4, the 1998 look), the
// shipped atlas.png (the HD upscale the .glb names) and, for la-cantina only,
// atlas-esrgan.png (Real-ESRGAN x4). The arena loads with the preferred one in
// place (render/meshMap.ts reads atlas-original.png for atlas.png when Classic
// is chosen); this module swaps material.map between them afterwards, from the
// Graphics drawer or the hotkeys in main.ts.
//
// Variants load LAZILY on first request and missing files are tolerated: every
// map commits atlas.png and atlas-original.png, only la-cantina its esrgan
// variant (owner decision) — for other maps that one 404s locally unless copied
// in, and the switcher just reports "missing". Render-only: no sim imports, no
// frame-loop work (everything here runs on a keypress or a load callback).

import * as THREE from "three";

/** Variant key -> atlas filename in the map's model folder. */
export const TEX_VARIANTS = {
  original: "atlas-original.png",
  hd: "atlas.png",
  esrgan: "atlas-esrgan.png",
} as const;

export type VariantName = keyof typeof TEX_VARIANTS;

// --- Player preference: "Textures: Classic / HD" ----------------------------
// Persisted client-local like the audio settings (audio/engine.ts,
// "metropolis.audio.v1"): versioned key, pure parser, try/catch around storage
// (private mode / quota). "original" (Classic) is the source texels, "hd" the
// shipped upscale (atlas.png).
//
// Classic is the default (owner's rule of 2026-10-13, PLAN.md Phase 14: only
// the original counts; HD stays as an option). It used to be HD. Only the
// drawer ever writes the stored value, so a stored "hd" is a choice a player
// made and is kept; a player who never chose gets Classic.

export type TexPref = "hd" | "original";

/** What a player who never chose sees: the original's texels. */
export const DEFAULT_TEX_PREF: TexPref = "original";

const PREF_KEY = "metropolis.gfx.v1";

/** Pure parser so URL params and stored JSON share one validation path. */
export function parseTexPref(raw: unknown): TexPref | null {
  return raw === "hd" || raw === "original" ? raw : null;
}

/** Stored preference, defaulting to Classic. */
export function loadTexPref(): TexPref {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    const pref = (parsed as { textures?: unknown }).textures;
    return parseTexPref(pref) ?? DEFAULT_TEX_PREF;
  } catch {
    return DEFAULT_TEX_PREF;
  }
}

export function saveTexPref(pref: TexPref): void {
  writeGfxPref("textures", pref);
}

// --- Player preference: "Bloom" ----------------------------------------------
// Same storage record as the texture pref; the writer merges so the two
// settings cannot clobber each other. Default ON — the dusk look is built
// around it; main.ts still forces it off on software renderers.

export function loadBloomPref(): boolean {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    const bloom = (parsed as { bloom?: unknown }).bloom;
    return typeof bloom === "boolean" ? bloom : true;
  } catch {
    return true;
  }
}

export function saveBloomPref(enabled: boolean): void {
  writeGfxPref("bloom", enabled);
}

/** Read-merge-write so every gfx pref shares one record without clobbering. */
function writeGfxPref(key: "textures" | "bloom", value: unknown): void {
  try {
    let current: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
      if (parsed !== null && typeof parsed === "object") {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt record: rebuild it from this write.
    }
    current[key] = value;
    localStorage.setItem(PREF_KEY, JSON.stringify(current));
  } catch {
    // Private mode / quota: the choice still applies for this session.
  }
}

/** Variant the preference selects. */
export function variantOfPref(pref: TexPref): VariantName {
  return pref === "original" ? "original" : "hd";
}

interface VariantSlot {
  tex: THREE.Texture | null;
  state: "unloaded" | "loading" | "ready" | "missing";
}

const loader = new THREE.TextureLoader();

/** Per-map runtime state; recreated on map swap (rebuildArena disposes it). */
export interface VariantSwitcher {
  readonly setVariant: (name: VariantName) => void;
  readonly active: () => VariantName;
  /** Last user-facing status line ("tex: esrgan", "tex: original (missing)"). */
  readonly status: () => string;
  readonly dispose: () => void;
}

/**
 * Creates the switcher for one loaded map mesh. `materials` come from
 * loadMapMesh's onMaterials callback; `mapId` names the asset directory;
 * `loaded` is the variant the mesh was loaded with (meshMap.ts). The
 * materials' own textures stand for that variant and are NOT disposed here —
 * rebuildArena owns them (main.ts).
 */
export function createVariantSwitcher(
  mapId: string,
  materials: readonly THREE.MeshStandardMaterial[],
  loaded: VariantName,
): VariantSwitcher {
  const defaults = materials.map((m) => m.map);
  const slots = new Map<string, VariantSlot>();
  for (const name of Object.keys(TEX_VARIANTS)) {
    slots.set(name, { tex: null, state: "unloaded" });
  }
  let active: VariantName = loaded;
  let statusLine = `tex: ${loaded}`;
  // Set by dispose(): the arena (and its materials) is gone, so late loader
  // callbacks must not touch materials and must free the texture they created.
  let disposed = false;
  // The variant the user selected LAST. An async load only applies itself when
  // it is still the requested one — otherwise a slow request would override a
  // newer selection (press 2, press 1, esrgan load finishes -> must not apply).
  let requested: VariantName = loaded;

  const apply = (tex: THREE.Texture | null, name: VariantName) => {
    for (let i = 0; i < materials.length; i++) {
      // null = restore each material's own texture (the `loaded` variant).
      materials[i].map = tex ?? defaults[i];
      materials[i].needsUpdate = true;
    }
    active = name;
    statusLine = `tex: ${name}`;
  };

  const setVariant = (name: VariantName) => {
    requested = name;
    if (name === loaded) {
      apply(null, loaded);
      return;
    }
    const slot = slots.get(name);
    if (!slot) return;
    if (slot.state === "ready" && slot.tex) {
      apply(slot.tex, name);
      return;
    }
    if (slot.state === "missing") {
      statusLine = `tex: ${name} (missing)`;
      return;
    }
    if (slot.state === "loading") {
      statusLine = `tex: ${name} (loading...)`;
      return;
    }
    slot.state = "loading";
    statusLine = `tex: ${name} (loading...)`;
    loader.load(
      `/models/${mapId}/${TEX_VARIANTS[name]}`,
      (tex) => {
        if (disposed) {
          // Map was swapped while this variant loaded: the materials this
          // switcher was built for are gone — drop the texture, don't apply.
          tex.dispose();
          return;
        }
        // Match the glTF sampler the shipped atlas uses: glTF textures are NOT
        // v-flipped, sRGB base color, repeat wrap, trilinear + anisotropy.
        // Classic too, over its nearest-x4 texels — not the original's filter:
        // its "Filtering" box (THRASH state 7) is on by default, and d3da.dll
        // makes state 7 bilinear without mipmaps (RE M3-OO), while the software
        // renderer point-samples (fcop-fidelity.md G3).
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        slot.tex = tex;
        slot.state = "ready";
        // Only take effect if this is still the variant the user wants — a
        // newer selection (incl. back to the loaded one) must not be overridden.
        if (requested === name) apply(tex, name);
      },
      undefined,
      () => {
        if (disposed) return;
        slot.state = "missing";
        if (requested === name) statusLine = `tex: ${name} (missing)`;
      },
    );
  };

  return {
    setVariant,
    active: () => active,
    status: () => statusLine,
    dispose: () => {
      if (disposed) return;
      // Point the materials back at their own textures first, so a variant
      // never dangles on a material and rebuildArena's mat.map.dispose() frees
      // the loaded atlas (not an already-disposed variant, leaking the atlas).
      apply(null, loaded);
      disposed = true;
      for (const slot of slots.values()) {
        slot.tex?.dispose();
        slot.tex = null;
        slot.state = "unloaded";
      }
    },
  };
}
