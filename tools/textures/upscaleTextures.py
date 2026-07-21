#!/usr/bin/env python3
# Authoring-time tool to upscale the committed FC terrain-texture atlases
# (packages/client/public/models/<map>/texNN.png) from their native 256x256 to a
# higher power-of-two resolution, and to compare upscalers before picking one.
#
# Runs at AUTHORING time only, like tools/generators/genBrand.py: the emitted map
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
#   tag                           WD14 tagger -> per-texture prompts in sd/tags.json
#   sd                            Stable Diffusion 1.5 img2img (local, CPU; auto-tags first)
#   compare                       colour-drift table + zoom contact-sheets per texture
#   integrate --from VARIANT      copy a variant's PNGs over the committed map textures
#
# The `tag`+`sd` pair is a fully local, ComfyUI-free img2img refine: WD14 looks at
# each texNN.png and emits per-texture tags (a fixed prompt does not fit concrete
# vs. metal vs. neon), then SD 1.5 img2img refines each tile using its own prompt.
# tags.json is an editable cache; hand-edit a `prompt` and re-run `sd` to iterate.
#
# Variants are written under tools/textures/_local/upscale/<variant>/ (git-ignored);
# `integrate` is the only step that touches the committed assets (with .bak backup).
#
# Requires: Pillow, numpy.  tag also: onnxruntime, huggingface_hub.
# sd also: torch, diffusers, transformers, accelerate, safetensors.
# Usage:    python tools/textures/upscaleTextures.py compare --map la-cantina

import argparse
import csv
import glob
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS = os.path.join(REPO, "packages", "client", "public", "models")
WORK = os.path.join(REPO, "tools", "textures", "_local", "upscale")

# WD14 tagger + SD img2img (local, ComfyUI-free) --------------------------------
WD14_MODEL = "SmilingWolf/wd-vit-tagger-v3"  # light, CPU-friendly; -v3 uses 448^2 input
# runwayml pulled its HF repo in 2024; this org mirrors the original SD 1.5 weights.
SD_MODEL = "stable-diffusion-v1-5/stable-diffusion-v1-5"
PROMPT_SUFFIX = "detailed game texture, sharp, pbr albedo"
SD_NEGATIVE = "blurry, jpeg artifacts, text, watermark, people, low quality"


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
    """Upscale via the pip `realesrgan` API (installed by tools/textures/upscale-esrgan.sh)."""
    try:
        import cv2
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
    except ImportError as ex:
        sys.exit(f"pip realesrgan stack missing ({ex}). Run tools/textures/run.sh "
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


# --- WD14 tag / SD img2img -------------------------------------------------
def tags_json_path(m: str) -> str:
    return os.path.join(variant_dir(m, "sd"), "tags.json")


def load_tags(m: str) -> dict:
    p = tags_json_path(m)
    if os.path.isfile(p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    return {}


def save_tags(m: str, data: dict) -> None:
    with open(tags_json_path(m), "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def build_prompt(tags: dict) -> str:
    parts = [t.replace("_", " ") for t in tags]
    return ", ".join(parts + [PROMPT_SUFFIX]) if parts else PROMPT_SUFFIX


def _wd14_session(repo_id: str):
    """Download the ONNX model + tag list and open a CPU inference session."""
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download
    model_path = hf_hub_download(repo_id, "model.onnx")
    tags_path = hf_hub_download(repo_id, "selected_tags.csv")
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    names, cats = [], []
    with open(tags_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            names.append(row["name"])
            cats.append(int(row["category"]))  # 0=general, 4=character, 9=rating
    return sess, names, cats


def _wd14_infer(sess, names, cats, im: Image.Image, threshold: float) -> dict:
    inp = sess.get_inputs()[0]
    size = inp.shape[1] if isinstance(inp.shape[1], int) else 448  # NHWC
    w, h = im.size
    s = max(w, h)
    canvas = Image.new("RGB", (s, s), (255, 255, 255))  # pad to square (white)
    canvas.paste(im, ((s - w) // 2, (s - h) // 2))
    arr = np.asarray(canvas.resize((size, size), Image.BICUBIC), dtype=np.float32)
    arr = arr[:, :, ::-1]  # RGB -> BGR, values stay 0..255 (model expects raw)
    probs = sess.run(None, {inp.name: np.expand_dims(arr, 0)})[0][0]
    hits = {n: float(p) for n, c, p in zip(names, cats, probs) if c == 0 and p >= threshold}
    return dict(sorted(hits.items(), key=lambda kv: kv[1], reverse=True))


def cmd_tag(a) -> int:
    try:
        import onnxruntime  # noqa: F401
        from huggingface_hub import hf_hub_download  # noqa: F401
    except ImportError as ex:
        sys.exit(f"WD14 deps missing ({ex}). Run tools/textures/run.sh (installs the venv), "
                 "or: pip install onnxruntime huggingface_hub")
    data = load_tags(a.map)
    sess = names = cats = None
    n = 0
    for t in textures(a.map):
        cur = data.get(t)
        if cur and cur.get("edited"):
            print(f"tag {t}: kept (edited)")
            continue
        if cur and "prompt" in cur and not a.force:
            print(f"tag {t}: cached")
            continue
        if sess is None:
            print(f">> loading WD14 ({a.wd_model}) ...", flush=True)
            sess, names, cats = _wd14_session(a.wd_model)
        tags = _wd14_infer(sess, names, cats, load(os.path.join(map_dir(a.map), f"{t}.png")), a.threshold)
        data[t] = {"prompt": build_prompt(tags),
                   "tags": {k: round(v, 3) for k, v in tags.items()}, "edited": False}
        print(f"tag {t}: {data[t]['prompt']}")
        n += 1
    save_tags(a.map, data)
    print(f"\ntags -> {tags_json_path(a.map)} ({n} newly tagged; edit a prompt + re-run sd)")
    return 0


def cmd_sd(a) -> int:
    try:
        import torch
        from diffusers import StableDiffusionImg2ImgPipeline
    except ImportError as ex:
        sys.exit(f"SD deps missing ({ex}). Run tools/textures/run.sh (installs the venv), or: "
                 "pip install torch diffusers transformers accelerate safetensors")
    data = load_tags(a.map)
    missing = [t for t in textures(a.map) if t not in data or "prompt" not in data[t]]
    if missing:
        print(f">> {len(missing)} texture(s) untagged — running WD14 first")
        rc = cmd_tag(a)
        if rc:
            return rc
        data = load_tags(a.map)

    print(f">> loading SD 1.5 on CPU ({a.model}; first run downloads weights) ...", flush=True)
    pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
        a.model, torch_dtype=torch.float32, safety_checker=None, requires_safety_checker=False)
    pipe.to("cpu")
    pipe.enable_attention_slicing()
    out = variant_dir(a.map, "sd")
    for t in textures(a.map):
        orig = load(os.path.join(map_dir(a.map), f"{t}.png"))
        w, h = orig.size
        init = orig.resize((a.size, a.size), Image.LANCZOS)  # 256 -> SD sweet spot
        prompt = data[t]["prompt"]
        gen = torch.Generator(device="cpu").manual_seed(a.seed)
        print(f"sd {t}: strength={a.strength} steps={a.steps} :: {prompt}", flush=True)
        res = pipe(prompt=prompt, negative_prompt=SD_NEGATIVE, image=init,
                   strength=a.strength, guidance_scale=a.guidance,
                   num_inference_steps=a.steps, generator=gen).images[0]
        warn = "" if is_pot(a.size) else f"  <-- {a.size} not power-of-two (integrate will refuse)"
        res.save(os.path.join(out, f"{t}.png"))
        print(f"  ok -> {a.size}x{a.size}{warn}")
    print("out:", out)
    print(f"next: python tools/textures/upscaleTextures.py compare --map {a.map}")
    return 0


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
             ("sd", os.path.join(WORK, a.map, "sd"))]
    outdir = variant_dir(a.map, "compare")
    for t in textures(a.map):
        orig = os.path.join(map_dir(a.map), f"{t}.png")
        present = [(n, os.path.join(d, f"{t}.png")) for n, d in order
                   if os.path.isfile(os.path.join(d, f"{t}.png"))]
        print(f"\n== {t} == colour-drift vs original (mean abs diff, 0..255 scale)")
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
    q = sub.add_parser("tag"); add_map(q)
    q.add_argument("--wd-model", dest="wd_model", default=WD14_MODEL)
    q.add_argument("--threshold", type=float, default=0.35)
    q.add_argument("--force", action="store_true", help="re-tag cached (non-edited) textures")
    q.set_defaults(fn=cmd_tag)
    q = sub.add_parser("sd"); add_map(q)
    q.add_argument("--model", default=SD_MODEL)
    q.add_argument("--wd-model", dest="wd_model", default=WD14_MODEL)
    q.add_argument("--threshold", type=float, default=0.35)
    q.add_argument("--strength", type=float, default=0.35, help="0=keep original .. 1=ignore it")
    q.add_argument("--guidance", type=float, default=7.0)
    q.add_argument("--steps", type=int, default=24)
    q.add_argument("--size", type=int, default=512, help="img2img working+output size (PoT square)")
    q.add_argument("--seed", type=int, default=0)
    q.add_argument("--force", action="store_true", help="re-tag cached (non-edited) textures")
    q.set_defaults(fn=cmd_sd)
    q = sub.add_parser("compare"); add_map(q); q.set_defaults(fn=cmd_compare)
    q = sub.add_parser("integrate"); add_map(q)
    q.add_argument("--from", required=True, help="variant name (lanczos|esrgan|sd) or a dir")
    q.add_argument("--no-backup", dest="backup", action="store_false"); q.set_defaults(fn=cmd_integrate)

    a = p.parse_args()
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
