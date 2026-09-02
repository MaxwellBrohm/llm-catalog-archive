#!/usr/bin/env python3
"""
Raster favicons, drawn to match src/site/build.ts FAVICON_SVG exactly.

WHY DRAWN AND NOT CONVERTED. There is no SVG rasteriser in this toolchain and
adding one for six shapes would be a dependency for a 475 byte file. The mark is
a rounded square, a rail, a lit upper section and three beads; PIL draws all of it, supersampled 8x so the curves are clean at 32px.

Run: python3 tools/make-favicons.py   (writes into src/site/, committed)
"""
from PIL import Image, ImageDraw
import os

VOID = (5, 5, 5, 255)
RAIL_DIM = (58, 28, 7, 255)
ORANGE = (255, 106, 0, 255)
HILITE = (255, 182, 128, 255)
S = 8  # supersample


def draw(size: int) -> Image.Image:
    n = size * S
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    u = n / 32.0  # one SVG unit in supersampled pixels

    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=7 * u, fill=VOID)
    d.rounded_rectangle([14.8 * u, 2.5 * u, 17.2 * u, 29.5 * u], radius=1.2 * u, fill=RAIL_DIM)
    d.rounded_rectangle([14.8 * u, 2.5 * u, 17.2 * u, 21.5 * u], radius=1.2 * u, fill=(168, 69, 11, 255))

    def bead(cy, hole, core, fill=ORANGE):
        c = 16 * u
        d.ellipse([c - hole * u, cy * u - hole * u, c + hole * u, cy * u + hole * u], fill=VOID)
        d.ellipse([c - core * u, cy * u - core * u, c + core * u, cy * u + core * u], fill=fill)

    bead(9, 5.6, 4.4)
    bead(19, 3.6, 2.5)
    bead(26.5, 2.6, 1.5, (138, 60, 10, 255))
    hx, hy, hr = 14.5 * u, 7.5 * u, 1.5 * u
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=HILITE)
    return im.resize((size, size), Image.LANCZOS)


out = os.path.join(os.path.dirname(__file__), "..", "src", "site")
draw(180).save(os.path.join(out, "apple-touch-icon.png"))
ico = [draw(s) for s in (16, 32, 48)]
ico[1].save(os.path.join(out, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
print("wrote src/site/apple-touch-icon.png and src/site/favicon.ico")
