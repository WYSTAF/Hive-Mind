#!/usr/bin/env python3
"""Generate HiveMind toolbar/store icons (hex + bee motif) as PNGs.

Pillow-only. Run:  python tools/gen_icons.py
Outputs icons/icon{16,32,48,128}.png next to the manifest.
"""
from PIL import Image, ImageDraw
import os

SIZES = [16, 32, 48, 128]
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")

AMBER = (255, 179, 0)      # honey
AMBER_DARK = (230, 145, 0)
BROWN = (94, 60, 23)       # hex outline
BG = (26, 26, 46)          # matches dark theme --bg


def draw_hex(d, cx, cy, r, fill=None, outline=None, width=1):
    pts = []
    for i in range(6):
        a = 3.14159 / 180 * (60 * i - 30)
        pts.append((cx + r * __import__("math").cos(a), cy + r * __import__("math").sin(a)))
    d.polygon(pts, fill=fill, outline=outline, width=width)


def make_icon(size: int) -> Image.Image:
    s = size / 128.0  # scale factor from the master design
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square background
    rad = int(24 * s)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=rad, fill=BG)

    # Honeycomb: three hex cells
    cx, cy = size / 2, size / 2
    r = 34 * s
    gap = 40 * s
    cells = [
        (cx - gap * 0.52, cy - gap * 0.28),
        (cx + gap * 0.52, cy - gap * 0.28),
        (cx, cy + gap * 0.55),
    ]
    for hx, hy in cells:
        draw_hex(d, hx, hy, r, fill=AMBER_DARK)

    # Bee dot flying toward the comb (top-right)
    br = 11 * s
    bx, by = size * 0.80, size * 0.20
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=AMBER)
    # wing stripe
    if size >= 32:
        d.line([bx - br * 0.5, by - br * 0.15, bx + br * 0.5, by + br * 0.15],
               fill=BROWN, width=max(1, int(3 * s)))

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for sz in SIZES:
        img = make_icon(sz)
        path = os.path.join(OUT_DIR, f"icon{sz}.png")
        img.save(path, "PNG")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
