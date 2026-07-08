#!/usr/bin/env python3
# Processes the committed brand source art (assets/brand/) into the runtime
# assets the client ships: the menu backdrop and the app/favicon icons.
#
# The sources are Gemini-generated art provided by the project owner as CC0
# (see CREDITS.md). This runs at AUTHORING time only, like the other generators
# in tools/gen; the emitted files under packages/client/public/ are the
# committed artifacts, so the deploy/CI path never needs Python or Pillow.
#
# What it does:
#   - wallpaper -> a JPEG menu backdrop; the "FUTURE COP" sign (an EA trademark
#     the project must not display) is blurred into an illegible glow.
#   - logo -> a square crop of the shield emblem (the "METROPOLIS" wordmark and
#     outer plaque are dropped; a wordmark makes a poor favicon), resized to the
#     PWA / favicon sizes.
#
# Requires Pillow:  pip install pillow
# Usage:            python3 tools/gen/genBrand.py

from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets" / "brand"
PUBLIC = ROOT / "packages" / "client" / "public"

# --- menu backdrop -----------------------------------------------------------

wallpaper = Image.open(SRC / "wallpaper.png").convert("RGB")
# Blur the "FUTURE COP" sign (left-centre) so the trademark text is unreadable
# while the panel still reads as a lit sign.
FUTURE_COP_BOX = (176, 384, 236, 414)
region = wallpaper.crop(FUTURE_COP_BOX).filter(ImageFilter.GaussianBlur(7))
wallpaper.paste(region, FUTURE_COP_BOX)
(PUBLIC / "bg").mkdir(parents=True, exist_ok=True)
wallpaper.save(PUBLIC / "bg" / "menu.jpg", quality=82, optimize=True, progressive=True)
print(f"wrote bg/menu.jpg ({wallpaper.width}x{wallpaper.height})")

# --- app / favicon icons -----------------------------------------------------

logo = Image.open(SRC / "logo.png").convert("RGB")
# Square crop around the shield emblem (drops the wordmark + outer plaque).
shield = logo.crop((88, 12, 384, 308))
ICONS = PUBLIC / "icons"
ICONS.mkdir(parents=True, exist_ok=True)
for size in (512, 192, 180, 32):
    shield.resize((size, size), Image.LANCZOS).save(ICONS / f"icon-{size}.png")
    print(f"wrote icons/icon-{size}.png ({size}x{size})")
