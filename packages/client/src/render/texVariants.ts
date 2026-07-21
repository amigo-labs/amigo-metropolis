// Debug texture-variant switcher for the textured map render path (?render=mesh).
//
// The atlas pipeline (RE-repo tools/gfx/atlas_repack.py) emits several atlas
// PNGs per map that share ONE pack layout — identical UVs, interchangeable
// pixels: atlas-original.png (source texels nearest-x4, the 1998 look) and
// atlas-esrgan.png (Real-ESRGAN x4). This module swaps material.map between
// them at runtime so texture quality can be judged in-game (hotkeys wired in
// main.ts; typically together with ?cam=fly).
//
// Variants load LAZILY on first request and missing files are tolerated: only
// la-cantina commits its variant PNGs (owner decision) — for other maps the
// files 404 locally unless copied in, and the switcher just reports
// "not available". Render-only debug tooling: no sim imports, no frame-loop
// work (everything here runs on a keypress or a load callback).

import * as THREE from "three";

/** Variant key -> atlas filename; "default" is whatever the .glb shipped with. */
export const TEX_VARIANTS = {
  original: "atlas-original.png",
  esrgan: "atlas-esrgan.png",
} as const;

export type VariantName = keyof typeof TEX_VARIANTS | "default";

// --- Player preference: "Textures: HD / Original" ---------------------------
// Persisted client-local like the audio settings (audio/engine.ts,
// "metropolis.audio.v1"): versioned key, pure parser, try/catch around storage
// (private mode / quota). "hd" maps to the shipped atlas.png (the ESRGAN
// atlas), "original" to the nearest-x4 source-texel variant.

export type TexPref = "hd" | "original";

const PREF_KEY = "metropolis.gfx.v1";

/** Pure parser so URL params and stored JSON share one validation path. */
export function parseTexPref(raw: unknown): TexPref | null {
  return raw === "hd" || raw === "original" ? raw : null;
}

/** Stored preference, defaulting to "hd". */
export function loadTexPref(): TexPref {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}");
    const pref = (parsed as { textures?: unknown }).textures;
    return parseTexPref(pref) ?? "hd";
  } catch {
    return "hd";
  }
}

export function saveTexPref(pref: TexPref): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ textures: pref }));
  } catch {
    // Private mode / quota: the choice still applies for this session.
  }
}

/** Variant the preference selects ("hd" = the shipped default atlas). */
export function variantOfPref(pref: TexPref): VariantName {
  return pref === "original" ? "original" : "default";
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
 * loadMapMesh's onMaterials callback; `mapId` names the asset directory.
 * The materials' original textures are captured as the "default" variant and
 * are NOT disposed here — rebuildArena owns them (main.ts).
 */
export function createVariantSwitcher(
  mapId: string,
  materials: readonly THREE.MeshStandardMaterial[],
): VariantSwitcher {
  const defaults = materials.map((m) => m.map);
  const slots = new Map<string, VariantSlot>();
  for (const name of Object.keys(TEX_VARIANTS)) {
    slots.set(name, { tex: null, state: "unloaded" });
  }
  let active: VariantName = "default";
  let statusLine = "tex: default";
  // Set by dispose(): the arena (and its materials) is gone, so late loader
  // callbacks must not touch materials and must free the texture they created.
  let disposed = false;
  // The variant the user selected LAST. An async load only applies itself when
  // it is still the requested one — otherwise a slow request would override a
  // newer selection (press 2, press 0, esrgan load finishes -> must not apply).
  let requested: VariantName = "default";

  const apply = (tex: THREE.Texture | null, name: VariantName) => {
    for (let i = 0; i < materials.length; i++) {
      // null = restore each material's own shipped texture.
      materials[i].map = tex ?? defaults[i];
      materials[i].needsUpdate = true;
    }
    active = name;
    statusLine = `tex: ${name}`;
  };

  const setVariant = (name: VariantName) => {
    requested = name;
    if (name === "default") {
      apply(null, "default");
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
      `/models/${mapId}/${TEX_VARIANTS[name as keyof typeof TEX_VARIANTS]}`,
      (tex) => {
        if (disposed) {
          // Map was swapped while this variant loaded: the materials this
          // switcher was built for are gone — drop the texture, don't apply.
          tex.dispose();
          return;
        }
        // Match the glTF sampler the shipped atlas uses: glTF textures are NOT
        // v-flipped, sRGB base color, repeat wrap, trilinear + anisotropy.
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
        // newer selection (incl. back to default) must not be overridden.
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
      // Point the materials back at their shipped textures first, so a variant
      // never dangles on a material and rebuildArena's mat.map.dispose() frees
      // the shipped atlas (not an already-disposed variant, leaking the atlas).
      apply(null, "default");
      disposed = true;
      for (const slot of slots.values()) {
        slot.tex?.dispose();
        slot.tex = null;
        slot.state = "unloaded";
      }
    },
  };
}
