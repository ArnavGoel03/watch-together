"""Cut assets/logo-master.png out of the delivered artwork.

Run: python3 scripts/make-master.py

The logo arrives as a JPEG of a glass panel floating on black with its glow around it.
Two things have to happen before it can be an icon, and both are recorded here rather
than done by hand so that a redraw is one command instead of an afternoon:

  1. Crop to the panel. Left whole, most of the frame is empty black, so a 16px toolbar
     icon would spend its pixels on surround and the mark would be a speck.
  2. Round the corners to transparent, so the icon sits on any toolbar colour instead of
     carrying a black square with it.

CROP_BOX is measured off the panel's own lit edge rather than its glow, by scanning rows
and columns for the first pixel above the glow's brightness. If the artwork is replaced,
re-measure rather than assuming these numbers still hold; run with --measure to print the
bounds the current source gives.
"""

import sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "logo-source.jpg"
MASTER = ROOT / "assets" / "logo-master.png"

SIDE = 900
CENTRE = (628, 624)
CORNER_RADIUS = 212
EDGE_THRESHOLD = 55  # above the glow, below the panel's lit edge


def measure(im):
    w, h = im.size
    px = im.load()
    rows, cols = [], []
    for y in (h // 4, h // 2, 3 * h // 4):
        xs = [x for x in range(w) if max(px[x, y]) > EDGE_THRESHOLD]
        if xs:
            rows.append((y, xs[0], xs[-1]))
    for x in (w // 4, w // 2, 3 * w // 4):
        ys = [y for y in range(h) if max(px[x, y]) > EDGE_THRESHOLD]
        if ys:
            cols.append((x, ys[0], ys[-1]))
    return rows, cols


def main():
    if not SOURCE.exists():
        raise SystemExit(f"No artwork at {SOURCE}.")
    src = Image.open(SOURCE).convert("RGB")

    if "--measure" in sys.argv:
        rows, cols = measure(src)
        print(f"source {src.size}")
        for y, a, b in rows:
            print(f"  row {y}: {a}..{b}")
        for x, a, b in cols:
            print(f"  col {x}: {a}..{b}")
        return

    cx, cy = CENTRE
    panel = src.crop(
        (cx - SIDE // 2, cy - SIDE // 2, cx + SIDE // 2, cy + SIDE // 2)
    ).convert("RGBA")

    mask = Image.new("L", (SIDE, SIDE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, SIDE - 1, SIDE - 1), radius=CORNER_RADIUS, fill=255
    )
    panel.putalpha(mask)
    panel.save(MASTER)
    print(f"wrote {MASTER.relative_to(ROOT)} {panel.size}")


if __name__ == "__main__":
    main()
