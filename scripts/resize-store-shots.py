"""Normalise the captured screenshots to exactly what the Chrome Web Store accepts.

Run: python3 scripts/resize-store-shots.py

The captures are taken at deviceScaleFactor 2 so text is sharp, which produces 2560x1600.
The store wants 1280x800 exactly, square corners, full bleed, no padding. It then displays
them downscaled again to 640x400, which is why the captions in the capture script are set
large: anything at UI size turns to mush at that scale.
"""

from pathlib import Path
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "assets" / "store"
TARGET = (1280, 800)


def main():
    shots = sorted(OUT.glob("*.png"))
    if not shots:
        raise SystemExit(f"No captures in {OUT}. Run node scripts/store-screenshots.mjs first.")

    for f in shots:
        im = Image.open(f).convert("RGB")
        if im.size != TARGET:
            im = im.resize(TARGET, Image.LANCZOS)
            im.save(f, "PNG", optimize=True)
        # Prove it, rather than trusting the resize.
        check = Image.open(f)
        assert check.size == TARGET, (f.name, check.size)
        kb = f.stat().st_size // 1024
        print(f"  {f.name:26} {check.size[0]}x{check.size[1]}  {kb} KB")

    print(f"\n{len(shots)} screenshots ready in assets/store, at exactly {TARGET[0]}x{TARGET[1]}.")


if __name__ == "__main__":
    main()
