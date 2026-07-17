#!/usr/bin/env bash
# One-shot Gemini refinement for a map's terrain atlas: runs the RE-repo atlas
# pipeline (per-tile ESRGAN + Gemini refine pass), then copies the emitted glb +
# atlas variants into this repo so the in-game switcher (keys 0/1/2/3 under
# ?render=mesh) can show them. Asks for the API key at runtime (read silently,
# never stored) unless GEMINI_API_KEY is already set. Gemini calls are cached in
# the RE-repo (extracted/atlas_cache/) — reruns and aborts never pay twice.
#
# Usage:  tools/textures/gemini-refine.sh [map]      (default: la-cantina)
#   map = map id (la-cantina, urban-jungle, ...) or mission container (Mp, Hk, ...)
# Env:    RE_REPO overrides the RE-repo location (default: sibling checkout).
set -euo pipefail

MAP="${1:-la-cantina}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
RE_REPO="${RE_REPO:-$(cd "$REPO/.." && pwd)/fcop-reverse-engineering}"
VENV="$REPO/tools/textures/_local/venv"

# map id <-> mission container (public/models/README.md)
declare -A CONT_OF=(
  [urban-jungle]=Conft [proving-ground]=Slim [la-cantina]=Mp
  [bug-hunt]=Joke [hollywood-keys]=Hk [venice-beach]=Ovmp
)
declare -A MAP_OF=(
  [Conft]=urban-jungle [Slim]=proving-ground [Mp]=la-cantina
  [Joke]=bug-hunt [Hk]=hollywood-keys [Ovmp]=venice-beach
)
if [ -n "${CONT_OF[$MAP]:-}" ]; then CONT="${CONT_OF[$MAP]}"
elif [ -n "${MAP_OF[$MAP]:-}" ]; then CONT="$MAP"; MAP="${MAP_OF[$CONT]}"
else
  echo "!! unknown map '$MAP' — use one of: ${!CONT_OF[*]} (or ${!MAP_OF[*]})"; exit 2
fi
[ -d "$RE_REPO/tools/gfx" ] || { echo "!! RE-repo not found at $RE_REPO (set RE_REPO)"; exit 2; }

# venv python (created/provisioned like tools/textures/run.sh)
venv_py() {
  if [ -f "$VENV/Scripts/python.exe" ]; then echo "$VENV/Scripts/python.exe"
  elif [ -f "$VENV/bin/python" ]; then echo "$VENV/bin/python"; fi
}
PY="$(venv_py)"
if [ -z "$PY" ]; then
  sys_py="$(command -v python3 || command -v python)" || { echo "!! no python on PATH"; exit 2; }
  echo ">> creating venv at $VENV"
  "$sys_py" -m venv "$VENV"
  PY="$(venv_py)"
  "$PY" -m pip install --quiet --upgrade pip
fi
# full stack: the atlas run re-does the per-tile ESRGAN pass before refining
"$PY" -c "import realesrgan, torch, cv2" 2>/dev/null || {
  echo ">> installing Real-ESRGAN stack (CPU torch — may take a few minutes) ..."
  "$PY" -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu
  "$PY" -m pip install --quiet Pillow numpy realesrgan
  "$PY" - <<'PYEOF'
import importlib.util, pathlib
spec = importlib.util.find_spec("basicsr")
if spec and spec.submodule_search_locations:
    f = pathlib.Path(spec.submodule_search_locations[0]) / "data" / "degradations.py"
    if f.exists():
        s = f.read_text(encoding="utf-8")
        bad = "from torchvision.transforms.functional_tensor import rgb_to_grayscale"
        good = "from torchvision.transforms.functional import rgb_to_grayscale"
        if bad in s:
            f.write_text(s.replace(bad, good), encoding="utf-8")
            print(">> patched basicsr degradations.py")
PYEOF
}
"$PY" -c "import google.genai" 2>/dev/null || "$PY" -m pip install --quiet google-genai

if [ -z "${GEMINI_API_KEY:-}" ]; then
  read -rsp "Gemini API key (https://aistudio.google.com/apikey): " GEMINI_API_KEY; echo
fi
export GEMINI_API_KEY
trap 'unset GEMINI_API_KEY' EXIT

echo ">> refining $MAP ($CONT) — per-tile ESRGAN + Gemini pass (cached/resumable)"
(cd "$RE_REPO" && "$PY" tools/gfx/atlas_repack.py "$CONT" --refine gemini)

SRC="$RE_REPO/extracted/meshes/$CONT/atlas"
DST="$REPO/packages/client/public/models/$MAP"
mkdir -p "$DST"
cp "$SRC/$CONT.glb" "$DST/$MAP.glb"
cp "$SRC"/atlas*.png "$DST/"
echo ">> installed into $DST:"
ls -la "$DST" | awk '$9 ~ /atlas|glb/ {print "   " $5 "\t" $9}'
echo ">> done. Test: bun run dev -> ?map=$MAP&render=mesh&cam=fly&play=1 (keys 0/1/2/3)"
