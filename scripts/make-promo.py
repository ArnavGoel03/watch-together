"""Cut the store's promotional images out of the delivered banner sheet.

Run: python3 scripts/make-promo.py

The artwork arrives as one sheet holding two compositions: a compact card (icon, headline,
address) and a full one that adds the deck line and the three proof lines. Neither is at a
size any store asks for, so this cuts each panel out and fits it to the sizes that are
actually required:

  1400x560  marquee promo tile, ratio 2.50, from the full panel
   440x280  small promo tile, ratio 1.57, from the compact panel
  1200x630  social card for the site, ratio 1.91, from the full panel

Each panel is fitted to the width and centred, on ground sampled from the sheet's own
background rather than a guess, because that is how the designer composed them: cards
floating on black. Fitting rather than cropping matters, since every one of these has the
headline running most of the width and a centre crop would cut it in half.

PANELS is measured off the delivered sheet. Automatic detection was tried and abandoned:
the brightest contiguous run inside a panel is the ICON's own inner card, not the outer
one, so it locked onto the wrong rectangle every time. If the sheet is replaced, run with
--measure, look at the crops it writes, and correct these numbers.
"""

import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "banner-source.jpg"
ASSETS = ROOT / "assets"
SITE_ASSETS = ROOT / "site" / "assets"

# left, top, right, bottom, on the delivered sheet.
PANELS = {
    "compact": (305, 30, 1270, 437),
    "full": (30, 465, 1542, 942),
}

# Each output: size, which panel, and how much of the width the panel should occupy.
# The margin keeps the card's lit edge from colliding with the image boundary, which is
# what makes it read as a card rather than as a cropped photograph.
OUTPUTS = (
    ("marquee-1400x560.png", (1400, 560), "full", 0.97),
    ("promo-tile-440x280.png", (440, 280), "compact", 0.95),
    ("og-card.png", (1200, 630), "full", 0.95),
)

SITE_COPIES = ("og-card.png",)


def compose(src, size, panel_box, fill):
    """Fit one panel into one output size, centred on the sheet's own ground."""
    panel = src.crop(panel_box)
    width = round(size[0] * fill)
    height = round(panel.height * width / panel.width)
    if height > size[1] * fill:
        height = round(size[1] * fill)
        width = round(panel.width * height / panel.height)
    panel = panel.resize((width, height), Image.LANCZOS)

    ground = src.getpixel((4, 4))
    out = Image.new("RGB", size, ground)
    out.paste(panel, ((size[0] - width) // 2, (size[1] - height) // 2))
    return out


def main():
    if not SOURCE.exists():
        raise SystemExit(f"No banner sheet at {SOURCE}.")
    src = Image.open(SOURCE).convert("RGB")

    if "--measure" in sys.argv:
        print(f"sheet {src.size}")
        for name, box in PANELS.items():
            crop = src.crop(box)
            out = ROOT / f"panel-{name}.png"
            crop.save(out)
            print(f"  {name}: {crop.size} ratio {crop.width / crop.height:.3f} -> {out.name}")
        return

    for name, size, panel, fill in OUTPUTS:
        image = compose(src, size, PANELS[panel], fill)
        image.save(ASSETS / name)
        print(f"  assets/{name} ({size[0]}x{size[1]}, from the {panel} panel)")

    for name in SITE_COPIES:
        (SITE_ASSETS / name).write_bytes((ASSETS / name).read_bytes())
        print(f"  site/assets/{name}")


if __name__ == "__main__":
    main()
