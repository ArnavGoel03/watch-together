"""Generate every icon size the project ships, from one master image.

Run: python3 scripts/make-icons.py

There is exactly one source of truth for the logo, assets/logo-master.png, and everything
else is derived. The previous version of this script DREW the icon in code from a
hardcoded violet-to-indigo gradient, which meant the artwork lived in a Python file, and
re-running it would have silently reinstated a design that had been deliberately replaced.
Deriving from a master image instead makes a logo change a one-file change.

Sizes and where each is required:
  16, 48, 128  both manifests (toolbar, extensions page, and the store listing icon)
  96           addons.mozilla.org wants this one
  32           favicon for the server's /join/ page
  440x280      Chrome Web Store promotional tile
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets" / "logo-master.png"
ICONS = ROOT / "extension" / "icons"

# The tile's background is sampled from the artwork itself, so it stays right if the
# logo is ever replaced.
TILE = (440, 280)


def main():
    if not MASTER.exists():
        raise SystemExit(f"No master at {MASTER}. Put the logo there and run again.")

    master = Image.open(MASTER).convert("RGBA")
    ICONS.mkdir(parents=True, exist_ok=True)

    for size in (16, 32, 48, 96, 128):
        master.resize((size, size), Image.LANCZOS).save(ICONS / f"icon{size}.png")
        print(f"  icon{size}.png")

    # Promotional tile: the mark on a ground taken from the artwork's own corner, so it
    # reads as one piece rather than a logo pasted onto an unrelated colour.
    ground = master.convert("RGB").getpixel((8, 8))
    tile = Image.new("RGB", TILE, ground)
    mark = master.resize((190, 190), Image.LANCZOS)
    tile.paste(mark, ((TILE[0] - 190) // 2, (TILE[1] - 190) // 2), mark)
    out = ROOT / "assets" / "promo-tile-440x280.png"
    tile.save(out)
    print(f"  {out.relative_to(ROOT)}")

    print(f"\nGenerated from {MASTER.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
