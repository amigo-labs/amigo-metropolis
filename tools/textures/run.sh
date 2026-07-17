#!/usr/bin/env bash
# Interactive wizard to upscale a map's terrain-texture atlases. Pick a METHOD and
# a MAP from the numbered menus; "Exit" quits. Real-ESRGAN and SD 1.5 run from a
# local, git-ignored venv (auto-created + installed on first use, so the heavy
# torch stack never touches the system Python). Wraps tools/textures/upscaleTextures.py.
#
# Usage:  bash tools/textures/run.sh
set -uo pipefail   # no -e: a failed action should return to the menu, not exit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MODELS="$REPO/packages/client/public/models"
VENV="$REPO/tools/textures/_local/venv"
TOOL="$REPO/tools/textures/upscaleTextures.py"
PY=""

venv_py() {
  if [ -f "$VENV/Scripts/python.exe" ]; then echo "$VENV/Scripts/python.exe"
  elif [ -f "$VENV/bin/python" ]; then echo "$VENV/bin/python"; fi
}

ensure_venv() {
  PY="$(venv_py)"
  if [ -z "$PY" ]; then
    # python3 first: Debian/Ubuntu ship no bare `python` by default.
    local sys_py
    sys_py="$(command -v python3 || command -v python)" \
      || { echo "!! no python3/python on PATH"; return 1; }
    echo ">> creating venv at $VENV"
    "$sys_py" -m venv "$VENV" || { echo "!! venv creation failed"; return 1; }
    PY="$(venv_py)"
    "$PY" -m pip install --quiet --upgrade pip
  fi
}

ensure_base() {   # Pillow + numpy (lanczos / compare)
  "$PY" -c "import PIL, numpy" 2>/dev/null || "$PY" -m pip install --quiet Pillow numpy
}

ensure_esrgan() {
  "$PY" -c "import realesrgan, torch, cv2" 2>/dev/null && return 0
  echo ">> installing Real-ESRGAN stack (CPU torch — may take a few minutes) ..."
  "$PY" -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu || return 1
  "$PY" -m pip install --quiet Pillow numpy realesrgan || return 1
  # basicsr ships a broken import on torchvision>=0.17 (functional_tensor removed)
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
  "$PY" -c "import realesrgan, torch, cv2; print('>> OK: torch', torch.__version__, '| cuda', torch.cuda.is_available())"
}

ensure_wd14() {   # WD14 tagger: onnxruntime + huggingface_hub (CPU inference)
  "$PY" -c "import onnxruntime, huggingface_hub" 2>/dev/null && return 0
  echo ">> installing WD14 tagger stack (onnxruntime) ..."
  "$PY" -m pip install --quiet onnxruntime huggingface_hub Pillow numpy || return 1
  "$PY" -c "import onnxruntime; print('>> OK: onnxruntime', onnxruntime.__version__)"
}

ensure_diffusers() {
  "$PY" -c "import torch, diffusers" 2>/dev/null && return 0
  echo ">> installing Stable Diffusion stack (CPU torch — may take a few minutes) ..."
  "$PY" -m pip install --quiet torch torchvision --index-url https://download.pytorch.org/whl/cpu || return 1
  "$PY" -m pip install --quiet diffusers transformers accelerate safetensors Pillow numpy || return 1
  "$PY" -c "import torch, diffusers; print('>> OK: torch', torch.__version__, '| diffusers', diffusers.__version__, '| cuda', torch.cuda.is_available())"
}

pick_map() {   # sets MAP; returns 1 on Exit / no maps
  local maps=() d
  for d in "$MODELS"/*/; do
    compgen -G "${d}tex*.png" >/dev/null 2>&1 && maps+=("$(basename "$d")")
  done
  if [ ${#maps[@]} -eq 0 ]; then echo "!! no maps with tex*.png under $MODELS"; return 1; fi
  maps+=("Exit")
  echo; echo "Select a MAP:"
  local m
  select m in "${maps[@]}"; do
    [ -z "${m:-}" ] && { echo "  invalid — enter a number"; continue; }
    [ "$m" = "Exit" ] && return 1
    MAP="$m"; return 0
  done
}

run_method() {   # $1 = method key
  ensure_venv || return
  case "$1" in
    lanczos) ensure_base; pick_map || return; "$PY" "$TOOL" lanczos --map "$MAP" ;;
    esrgan)  ensure_esrgan || { echo "!! ESRGAN install failed"; return; }
             pick_map || return; "$PY" "$TOOL" esrgan --map "$MAP" ;;
    sd)      ensure_wd14 || { echo "!! WD14 install failed"; return; }
             ensure_diffusers || { echo "!! SD install failed"; return; }
             pick_map || return; "$PY" "$TOOL" sd --map "$MAP" ;;
    compare) ensure_base; pick_map || return; "$PY" "$TOOL" compare --map "$MAP" ;;
  esac
}

echo "== FC terrain-texture upscaler =="
PS3=$'\nMethod # (Exit to quit): '
while true; do
  select method in "Lanczos (faithful baseline)" "Real-ESRGAN (sharp, pip)" \
                   "SD 1.5 img2img (WD14 tag, local CPU)" \
                   "Compare variants" "Exit"; do
    case "${method:-}" in
      Lanczos*)      run_method lanczos ;;
      Real-ESRGAN*)  run_method esrgan ;;
      SD*)           run_method sd ;;
      Compare*)      run_method compare ;;
      Exit)          echo "bye"; exit 0 ;;
      *)             echo "  invalid — enter a number" ;;
    esac
    break   # leave select so the method menu is reprinted by the outer loop
  done
done
