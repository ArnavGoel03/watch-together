from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"

TOP = (167, 139, 250)      # violet-400  #a78bfa
BOT = (99, 102, 241)       # indigo-500  #6366f1
WHITE = (255, 255, 255, 255)


def gradient_bg(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            r = int(TOP[0] + (BOT[0] - TOP[0]) * t)
            g = int(TOP[1] + (BOT[1] - TOP[1]) * t)
            b = int(TOP[2] + (BOT[2] - TOP[2]) * t)
            px[x, y] = (r, g, b, 255)
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def play_triangle(draw, cx, cy, radius, fill, rotation_deg=0):
    import math
    pts = []
    for i in range(3):
        a = math.radians(rotation_deg + i * 120)
        pts.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    draw.polygon(pts, fill=fill)


def make_icon(size):
    ss = 8 if size < 64 else 4
    s = size * ss

    bg = gradient_bg(s)
    mask = rounded_mask(s, int(s * 0.22))
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    # Soft inner highlight at top
    hi = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    hdraw = ImageDraw.Draw(hi)
    hdraw.ellipse([-s * 0.3, -s * 0.7, s * 1.3, s * 0.3], fill=(255, 255, 255, 40))
    hi = hi.filter(ImageFilter.GaussianBlur(radius=s * 0.02))
    hi.putalpha(Image.eval(hi.split()[3], lambda a: a))
    hi_masked = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    hi_masked.paste(hi, (0, 0), mask)
    canvas = Image.alpha_composite(canvas, hi_masked)

    draw = ImageDraw.Draw(canvas)

    # Echo triangle (subtle, behind) — communicates "sync / two viewers"
    cx, cy = s / 2, s / 2
    r_front = s * 0.28
    r_back = s * 0.28
    offset = s * 0.055

    # Back triangle: translucent white
    play_triangle(draw, cx - offset, cy - offset * 0.2, r_back, (255, 255, 255, 110), rotation_deg=0)

    # Front triangle: crisp white, slightly offset right+down for optical balance
    # (play triangles look centered when nudged right of geometric center)
    play_triangle(draw, cx + offset * 0.6, cy + offset * 0.1, r_front, WHITE, rotation_deg=0)

    return canvas.resize((size, size), Image.LANCZOS)


def make_icon_16():
    # At 16px, skip the echo/gradient tricks — pixel-snap for clarity.
    s = 16
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    mask = rounded_mask(s, 3)
    bg = Image.new("RGBA", (s, s), BOT + (255,))
    img.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    # Play triangle tuned to pixel grid
    pts = [(5, 4), (5, 12), (12, 8)]
    draw.polygon(pts, fill=WHITE)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    make_icon_16().save(OUT / "icon16.png")
    make_icon(48).save(OUT / "icon48.png")
    make_icon(128).save(OUT / "icon128.png")
    print("wrote:", *(OUT / f"icon{n}.png" for n in (16, 48, 128)))


if __name__ == "__main__":
    main()
