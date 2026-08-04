// Arena gallery. Selecting a card swaps the live 3D backdrop through
// opts.onSelect, so the picker doubles as the preview.

import { getMapById, MAP_REGISTRY } from "@metropolis/sim";
import { useRef } from "preact/hooks";
import { drawArenaThumbnail } from "../../render/arenaThumb";

interface Props {
  mapId: string;
  onPick(id: string): void;
}

/**
 * Prefers the rendered combat-zone preview (public/models/<id>/preview.png, an
 * isometric shot of the arena core) and falls back to the procedural top-down
 * minimap drawn straight from MapData.
 */
function ArenaThumb({ id }: { id: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  return (
    <>
      <img
        class="menu-arena-thumb"
        src={`/models/${encodeURIComponent(id)}/preview.png`}
        alt=""
        loading="lazy"
        decoding="async"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
          const el = canvas.current;
          if (!el || el.dataset.drawn) return;
          el.style.display = "";
          try {
            drawArenaThumbnail(el, getMapById(id));
            el.dataset.drawn = "1";
          } catch {
            // A missing or malformed map JSON must not blank the whole menu —
            // the card just shows its name over an empty tile.
          }
        }}
      />
      <canvas class="menu-arena-thumb" ref={canvas} width={200} height={200} style="display:none" />
    </>
  );
}

export function ArenaPicker({ mapId, onPick }: Props) {
  return (
    <section class="menu-section">
      <div class="ck-label">Arena</div>
      <div class="menu-arena-grid">
        {MAP_REGISTRY.map((info) => (
          <button
            type="button"
            key={info.id}
            class={`menu-arena-card ck-panel${info.id === mapId ? " is-active" : ""}`}
            aria-label={info.displayName}
            aria-pressed={info.id === mapId}
            onClick={() => onPick(info.id)}
          >
            <ArenaThumb id={info.id} />
            <span class="menu-arena-name">{info.displayName}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
