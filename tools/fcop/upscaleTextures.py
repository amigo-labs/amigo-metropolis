#!/usr/bin/env python3
# Authoring-time tool to upscale the committed FC terrain-texture atlases
# (packages/client/public/models/<map>/texNN.png) from their native 256x256 to a
# higher power-of-two resolution, and to compare upscalers before picking one.
#
# Runs at AUTHORING time only, like tools/gen/genBrand.py: the emitted map
# textures are committed artifacts, so the deploy/CI path never needs Python,
# Pillow, a GPU or any model. Higher-res textures are a pure asset swap on the
# client (the .glb references them by relative filename; UVs are normalized, the
# sampler/mipmaps/sRGB come from the glTF) as long as they stay power-of-two.
#
# The textures are TILE ATLASES (many tile graphics packed per 256^2 image,
# indexed by the mesh UVs), NOT single tiling textures. This does a WHOLE-ATLAS
# upscale; if an upscaler visibly bleeds across tile edges, a per-tile split
# (using the Til UV table) in the RE-repo pipeline is the fallback.
#
# Subcommands (default map: la-cantina):
#   lanczos                       faithful, soft baseline (no new detail)
#   esrgan   --bin PATH           Real-ESRGAN via realesrgan-ncnn-vulkan (Vulkan GPU)
#   gemini                        Gemini 2.5 Flash Image (generative; needs GEMINI_API_KEY)
#   compare                       colour-drift table + zoom contact-sheets per texture
#   integrate --from VARIANT      copy a variant's PNGs over the committed map textures
#
# Variants are written under tools/fcop/_local/upscale/<variant>/ (git-ignored);
# `integrate` is the only step that touches the committed assets (with .bak backup).
#
# Requires: Pillow, numpy.  gemini also: google-genai (pip install google-genai)
# Usage:    python tools/fcop/upscaleTextures.py compare --map la-cantina

import argparse
import glob
import io
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS = os.path.join(REPO, "packages", "client", "public", "models")
WORK = os.path.join(REPO, "tools", "fcop", "_local", "upscale")

GEMINI_PROMPT = (
    "Upscale this retro game texture atlas to a higher resolution. Preserve the "
    "EXACT colors, palette, layout and every cell/tile boundary. Sharpen and add "
    "fine detail only WITHIN each existing tile; do not add, remove, move or "
    "invent any elements, and keep every edge aligned. Output only the image."
)


def is_pot(n: int) -> bool:
    return n > 0 and (n & (n - 1)) == 0


def map_dir(m: str) -> str:
    d = os.path.join(MODELS, m)
    if not os.path.isdir(d):
        sys.exit(f"map dir not found: {d}")
    return d


def textures(m: str) -> list[str]:
    names = [os.path.splitext(os.path.basename(p))[0]
             for p in sorted(glob.glob(os.path.join(map_dir(m), "tex*.png")))]
    if not names:
        sys.exit(f"no tex*.png in {map_dir(m)}")
    return names


def load(path: str) -> Image.Image:
    return Image.open(path).convert("RGB")


def variant_dir(m: str, name: str) -> str:
    d = os.path.join(WORK, m, name)
    os.makedirs(d, exist_ok=True)
    return d


# --- upscalers -------------------------------------------------------------
def cmd_lanczos(a) -> int:
    if not is_pot(a.size):
        sys.exit(f"--size must be power-of-two, got {a.size}")
    out = variant_dir(a.map, "lanczos")
    for t in textures(a.map):
        load(os.path.join(map_dir(a.map), f"{t}.png")).resize(
            (a.size, a.size), Image.LANCZOS).save(os.path.join(out, f"{t}.png"))
        print(f"lanczos {t} -> {a.size}x{a.size}")
    print("out:", out)
    return 0


def cmd_esrgan(a) -> int:
    out = variant_dir(a.map, "esrgan")
    return _esrgan_ncnn(a, out) if a.bin else _esrgan_pip(a, out)


def _esrgan_ncnn(a, out) -> int:
    """Upscale via the portable realesrgan-ncnn-vulkan binary (Vulkan GPU)."""
    if not os.path.isfile(a.bin):
        sys.exit(f"binary not found: {a.bin}")
    ok = True
    for t in textures(a.map):
        src = os.path.join(map_dir(a.map), f"{t}.png")
        dst = os.path.join(out, f"{t}.png")
        cmd = [a.bin, "-i", src, "-o", dst, "-s", str(a.scale), "-n", a.model]
        if a.model_dir:
            cmd += ["-m", a.model_dir]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"  {t} FAILED: {r.stderr.strip()[:300]}", file=sys.stderr)
            ok = False
            continue
        w, h = Image.open(dst).size
        warn = "" if is_pot(w) and w == h else f"  <-- not square PoT ({w}x{h})!"
        print(f"esrgan {t} -> {w}x{h}{warn}")
    print("out:", out)
    return 0 if ok else 1


# model name -> (weights url auto-downloaded by RealESRGANer, num RRDB blocks)
_ESRGAN_WEIGHTS = {
    "realesrgan-x4plus": (
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth", 23),
    "realesrgan-x4plus-anime": (
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth", 6),
}


def _esrgan_pip(a, out) -> int:
    """Upscale via the pip `realesrgan` API (installed by tools/fcop/upscale-esrgan.sh)."""
    try:
        import cv2
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
    except ImportError as ex:
        sys.exit(f"pip realesrgan stack missing ({ex}). Run tools/fcop/upscale-esrgan.sh "
                 "(it installs the venv + patches basicsr), or pass --bin for the ncnn binary.")
    url, num_block = _ESRGAN_WEIGHTS.get(a.model, _ESRGAN_WEIGHTS["realesrgan-x4plus"])
    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=num_block, num_grow_ch=32, scale=4)
    up = RealESRGANer(scale=4, model_path=url, model=model, tile=0, tile_pad=10, pre_pad=0, half=False)
    for t in textures(a.map):
        src = os.path.join(map_dir(a.map), f"{t}.png")
        dst = os.path.join(out, f"{t}.png")
        img = cv2.imdecode(np.fromfile(src, dtype=np.uint8), cv2.IMREAD_COLOR)  # Windows-safe read
        output, _ = up.enhance(img, outscale=a.scale)
        cv2.imencode(".png", output)[1].tofile(dst)  # Windows-safe write
        h, w = output.shape[:2]
        warn = "" if is_pot(w) and w == h else f"  <-- not square PoT ({w}x{h})!"
        print(f"esrgan(pip) {t} -> {w}x{h}{warn}")
    print("out:", out)
    return 0


def cmd_gemini(a) -> int:
    if not is_pot(a.size):
        sys.exit(f"--size must be power-of-two, got {a.size}")
    key = a.api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not key:
        sys.exit("set GEMINI_API_KEY (or --api-key): https://aistudio.google.com/apikey")
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        sys.exit("pip install google-genai")
    client = genai.Client(api_key=key)
    out = variant_dir(a.map, "gemini")
    ok = True
    for t in textures(a.map):
        with open(os.path.join(map_dir(a.map), f"{t}.png"), "rb") as fh:
            data = fh.read()
        print(f"gemini {t} ...", flush=True)
        try:
            resp = client.models.generate_content(
                model=a.model,
                contents=[GEMINI_PROMPT, types.Part.from_bytes(data=data, mime_type="image/png")],
                config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
            )
        except Exception as ex:  # noqa: BLE001
            print(f"  API error: {ex}", file=sys.stderr)
            ok = False
            continue
        raw = next((bytes(p.inline_data.data) for p in (resp.parts or [])
                    if getattr(p, "inline_data", None) and isinstance(getattr(p.inline_data, "data", None), (bytes, bytearray))), None)
        if raw is None:
            print(f"  no image returned (safety block?). text={getattr(resp, 'text', None)!r}", file=sys.stderr)
            ok = False
            continue
        im = load(io.BytesIO(raw))
        if im.size != (a.size, a.size):
            print(f"  note: model returned {im.size}, fitting to {a.size} PoT")
            im = im.resize((a.size, a.size), Image.LANCZOS)
        im.save(os.path.join(out, f"{t}.png"))
        print(f"  ok -> {a.size}x{a.size}")
    print("out:", out)
    return 0 if ok else 1


# --- compare / integrate ---------------------------------------------------
def _drift(variant_path: str, orig_path: str):
    a = np.asarray(load(orig_path), dtype=np.float64)
    b = np.asarray(load(variant_path).resize((a.shape[1], a.shape[0]), Image.LANCZOS), dtype=np.float64)
    d = np.abs(a - b)
    return d.mean(), d[..., 0].mean(), d[..., 1].mean(), d[..., 2].mean()


def _crop(path: str, box):
    im = load(path)
    if im.size[0] < 1024:
        im = im.resize((1024, 1024), Image.NEAREST)  # show the original's blocky texels
    elif im.size != (1024, 1024):
        im = im.resize((1024, 1024), Image.LANCZOS)
    x0, y0, x1, y1 = (int(c * 1024) for c in box)
    return im.crop((x0, y0, x1, y1))


def cmd_compare(a) -> int:
    box = (0.29, 0.29, 0.79, 0.79)
    order = [("original", map_dir(a.map)),
             ("lanczos", os.path.join(WORK, a.map, "lanczos")),
             ("esrgan", os.path.join(WORK, a.map, "esrgan")),
             ("gemini", os.path.join(WORK, a.map, "gemini"))]
    outdir = variant_dir(a.map, "compare")
    for t in textures(a.map):
        orig = os.path.join(map_dir(a.map), f"{t}.png")
        present = [(n, os.path.join(d, f"{t}.png")) for n, d in order
                   if os.path.isfile(os.path.join(d, f"{t}.png"))]
        print(f"\n== {t} == colour-drift vs original (mean-abs-diff /255)")
        for n, p in present:
            if n == "original":
                continue
            m, r, g, b = _drift(p, orig)
            print(f"   {n:8s} total={m:5.2f}  R={r:4.1f} G={g:4.1f} B={b:4.1f}")
        crops = [(n, _crop(p, box)) for n, p in present]
        cw = crops[0][1].width
        sheet = Image.new("RGB", (cw * len(crops) + 8 * (len(crops) - 1), cw + 30), (18, 18, 22))
        dr = ImageDraw.Draw(sheet)
        for i, (n, im) in enumerate(crops):
            sheet.paste(im, (i * (cw + 8), 30))
            dr.text((i * (cw + 8) + 4, 9), n, fill=(235, 235, 235))
        sheet.save(os.path.join(outdir, f"cmp_{t}.png"))
    print("\ncontact-sheets:", outdir)
    return 0


def cmd_integrate(a) -> int:
    frm = a.__dict__["from"]
    src_dir = frm if os.path.isabs(frm) or os.path.isdir(frm) else os.path.join(WORK, a.map, frm)
    if not os.path.isdir(src_dir):
        sys.exit(f"variant dir not found: {src_dir}")
    dst_dir = map_dir(a.map)
    n = 0
    for t in textures(a.map):
        src = os.path.join(src_dir, f"{t}.png")
        if not os.path.isfile(src):
            print(f"  skip {t}: not in variant")
            continue
        w, h = Image.open(src).size
        if not (is_pot(w) and w == h):
            sys.exit(f"{t}: {w}x{h} is not square power-of-two — refusing to integrate")
        dst = os.path.join(dst_dir, f"{t}.png")
        if a.backup and os.path.isfile(dst):
            shutil.copyfile(dst, dst + ".bak")
        shutil.copyfile(src, dst)
        print(f"integrate {t}: {w}x{h} -> {dst}" + (" (backup .bak)" if a.backup else ""))
        n += 1
    print(f"done, {n} textures. Verify: bun run dev  ->  ?map={a.map}&render=mesh")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_map(q):
        q.add_argument("--map", default="la-cantina")

    q = sub.add_parser("lanczos"); add_map(q); q.add_argument("--size", type=int, default=1024); q.set_defaults(fn=cmd_lanczos)
    q = sub.add_parser("esrgan"); add_map(q)
    q.add_argument("--bin", default=None, help="realesrgan-ncnn-vulkan binary; omit to use the pip realesrgan API")
    q.add_argument("--model", default="realesrgan-x4plus")
    q.add_argument("--model-dir", default=None); q.add_argument("--scale", type=int, default=4); q.set_defaults(fn=cmd_esrgan)
    q = sub.add_parser("gemini"); add_map(q)
    q.add_argument("--model", default="gemini-2.5-flash-image"); q.add_argument("--size", type=int, default=1024)
    q.add_argument("--api-key", default=None); q.set_defaults(fn=cmd_gemini)
    q = sub.add_parser("compare"); add_map(q); q.set_defaults(fn=cmd_compare)
    q = sub.add_parser("integrate"); add_map(q)
    q.add_argument("--from", required=True, help="variant name (lanczos|esrgan|gemini) or a dir")
    q.add_argument("--no-backup", dest="backup", action="store_false"); q.set_defaults(fn=cmd_integrate)

    a = p.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
