"""Generate every icon the project ships, from one master image.

Run: python3 scripts/make-icons.py

There is exactly one source of truth for the logo, assets/logo-master.png, and everything
else is derived. An earlier version of this script DREW the icon in code from a hardcoded
gradient, which meant the artwork lived in a Python file, and re-running it would have
silently reinstated a design that had been deliberately replaced. Deriving from a master
image instead makes a logo change a one-file change.

The master itself is cut from assets/logo-source.jpg by scripts/make-master.py, so the
original delivered artwork stays in the repo and the crop is reproducible rather than a
one-off done by hand.

Outputs and where each is required:
  extension/icons/16,48,128   both manifests: toolbar, extensions page, store listing
  extension/icons/96          addons.mozilla.org asks for this one
  extension/icons/32          favicon for the relay's /join/ page
  assets/logo.png, logo-256   press and og:image use
  assets/favicon-32.png       site favicon

The store's promotional tiles are NOT here. They are cut from the delivered banner by
scripts/make-promo.py, because they carry the headline and cannot be derived from an icon.
  site/assets/*               copies, because the site deploys as its own root

The 128 is the one size that is NOT full bleed. Chrome's store guidance puts the artwork
inside a 96x96 box with 16px of transparent padding, because the store draws its own
container around it and a full-bleed icon collides with that container's corners.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets" / "logo-master.png"
ICONS = ROOT / "extension" / "icons"
SITE_ASSETS = ROOT / "site" / "assets"

# 48 and up are the master straight down. 16 and 32 are not: at those sizes the ring
# around the play mark falls below one pixel of stroke and dissolves into noise, taking
# the triangle's edge with it, so the toolbar shows a coloured smudge. Those two sizes
# get a tighter crop of the same artwork, which spends the pixels on the mark instead of
# the panel's margin, plus a small colour and contrast lift to survive the resample.
# Shipping different artwork per size is what Apple and Google both do; the alternative
# is an illegible toolbar icon.
FULL_BLEED = (48, 96)
SMALL = (16, 32)
SMALL_ZOOM = 0.70
SMALL_SATURATION = 1.25
SMALL_CONTRAST = 1.15
CORNER_RADIUS_FRACTION = 0.235
STORE_ICON = 128
STORE_ICON_ART = 96  # leaves 16px of padding a side, per the store's icon guidance

# Which of the derived files the site serves. Kept as a list so adding one is a one-line
# change here rather than a copy step someone has to remember.
SITE_FILES = ("logo-256.png", "favicon-32.png")


def crop_to_mark(master):
    """Zoom into the artwork and lift its colour, for the sizes too small to hold detail."""
    side = int(master.width * SMALL_ZOOM)
    off = (master.width - side) // 2
    im = master.crop((off, off, off + side, off + side))

    lifted = ImageEnhance.Color(im.convert("RGB")).enhance(SMALL_SATURATION)
    lifted = ImageEnhance.Contrast(lifted).enhance(SMALL_CONTRAST).convert("RGBA")

    mask = Image.new("L", lifted.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, side - 1, side - 1), radius=int(side * CORNER_RADIUS_FRACTION), fill=255
    )
    lifted.putalpha(mask)
    return lifted


def main():
    if not MASTER.exists():
        raise SystemExit(f"No master at {MASTER}. Run scripts/make-master.py first.")

    master = Image.open(MASTER).convert("RGBA")
    ICONS.mkdir(parents=True, exist_ok=True)
    SITE_ASSETS.mkdir(parents=True, exist_ok=True)

    for size in FULL_BLEED:
        master.resize((size, size), Image.LANCZOS).save(ICONS / f"icon{size}.png")
        print(f"  extension/icons/icon{size}.png")

    tight = crop_to_mark(master)
    for size in SMALL:
        tight.resize((size, size), Image.LANCZOS).save(ICONS / f"icon{size}.png")
        print(f"  extension/icons/icon{size}.png (tight crop, for legibility)")

    padded = Image.new("RGBA", (STORE_ICON, STORE_ICON), (0, 0, 0, 0))
    art = master.resize((STORE_ICON_ART, STORE_ICON_ART), Image.LANCZOS)
    inset = (STORE_ICON - STORE_ICON_ART) // 2
    padded.paste(art, (inset, inset), art)
    padded.save(ICONS / f"icon{STORE_ICON}.png")
    print(f"  extension/icons/icon{STORE_ICON}.png ({STORE_ICON_ART}px art, {inset}px padding)")

    for name, size in (("logo.png", 512), ("logo-256.png", 256)):
        master.resize((size, size), Image.LANCZOS).save(ROOT / "assets" / name)
        print(f"  assets/{name}")

    # The site favicon is drawn at browser-tab size, so it has the same problem the
    # toolbar icon has and takes the same tight crop.
    tight.resize((32, 32), Image.LANCZOS).save(ROOT / "assets" / "favicon-32.png")
    print("  assets/favicon-32.png (tight crop)")

    for name in SITE_FILES:
        (SITE_ASSETS / name).write_bytes((ROOT / "assets" / name).read_bytes())
        print(f"  site/assets/{name}")

    print(f"\nGenerated from {MASTER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
