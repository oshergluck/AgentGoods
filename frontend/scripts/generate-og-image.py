"""
Generate the Open Graph share card: public/og.png, 1200x630.

Why a PNG and not the SVG we already have:

    WhatsApp and Telegram do not render SVG for a link preview. Neither does iMessage, Slack or
    X. `og:image` pointed at favicon.svg, so every shared link showed no image at all -- the tag
    was present and valid, and the one format it named was the one format no chat client accepts.

Why generated rather than drawn by hand: the mark, the colours and the wording live in the app.
A card exported once from a design tool goes stale silently the first time any of them changes,
and nobody notices, because the card is only ever seen by people who are not us.

Run:  python frontend/scripts/generate-og-image.py
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1200, 630

BG = (5, 7, 13)
TEXT = (233, 238, 248)
MUTED = (139, 150, 173)
ACCENT_A = (56, 225, 210)   # #38e1d2
ACCENT_B = (139, 124, 246)  # #8b7cf6

OUT = os.path.join(os.path.dirname(__file__), "..", "public", "og.png")

# Supersampled, then downscaled once at the end. Pillow has no antialiasing on polygon fills, and
# the isometric cube is nothing but diagonal edges -- at 1x they come out visibly stepped.
SS = 3


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """The first available system face. The output is a committed PNG, so this only has to
    resolve on whatever machine regenerates the card, not at runtime."""
    candidates = (
        ["segoeuib.ttf", "arialbd.ttf", "calibrib.ttf"] if bold
        else ["segoeui.ttf", "arial.ttf", "calibri.ttf"]
    )
    roots = [r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts"]
    if not bold:
        candidates += ["DejaVuSans.ttf", "Helvetica.ttc"]
    else:
        candidates += ["DejaVuSans-Bold.ttf", "Helvetica.ttc"]

    for root in roots:
        for name in candidates:
            path = os.path.join(root, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
    print("warning: no TrueType font found, falling back to the bitmap default", file=sys.stderr)
    return ImageFont.load_default()


def gradient(size: tuple[int, int], a: tuple[int, int, int], b: tuple[int, int, int]) -> Image.Image:
    """A diagonal two-stop gradient, matching the `x1=0 y1=0 x2=1 y2=1` gradient in Logo.tsx."""
    w, h = size
    img = Image.new("RGB", size)
    pixels = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / max(w - 1, 1) + y / max(h - 1, 1)) / 2
            pixels[x, y] = (
                int(a[0] + (b[0] - a[0]) * t),
                int(a[1] + (b[1] - a[1]) * t),
                int(a[2] + (b[2] - a[2]) * t),
            )
    return img


def draw_mark(canvas: Image.Image, cx: float, cy: float, scale: float) -> None:
    """The AgentGoods mark, polygon-for-polygon from Logo.tsx.

    Kept as the same coordinates in the same 32-unit box rather than redrawn, so the card and the
    favicon cannot drift apart. The faces are separated by opacity exactly as they are in the
    component: 1.0 on the top, 0.78 right, 0.52 left."""
    def pt(x: float, y: float) -> tuple[float, float]:
        return (cx + (x - 16) * scale, cy + (y - 16) * scale)

    faces = [
        ([(16, 2.2), (21.2, 5), (16, 7.8), (10.8, 5)], 1.00),      # the unit in transit
        ([(16, 9.8), (23.97, 14.4), (16, 19), (8.03, 14.4)], 1.00),  # top face
        ([(23.97, 14.4), (23.97, 23.6), (16, 28.2), (16, 19)], 0.78),  # right
        ([(8.03, 14.4), (16, 19), (16, 28.2), (8.03, 23.6)], 0.52),   # left
    ]

    box = int(34 * scale)
    fill = gradient((box, box), ACCENT_A, ACCENT_B)
    origin = (int(cx - 17 * scale), int(cy - 17 * scale))

    for points, opacity in faces:
        mask = Image.new("L", canvas.size, 0)
        ImageDraw.Draw(mask).polygon([pt(x, y) for x, y in points], fill=int(255 * opacity))
        layer = Image.new("RGB", canvas.size, BG)
        layer.paste(fill, origin)
        canvas.paste(layer, (0, 0), mask)


def main() -> None:
    img = Image.new("RGB", (WIDTH * SS, HEIGHT * SS), BG)
    draw = ImageDraw.Draw(img)

    # A soft accent wash in the corner, echoing the ambient background on the site. Drawn as
    # concentric translucent rings because Pillow has no radial gradient.
    glow = Image.new("RGB", img.size, BG)
    gdraw = ImageDraw.Draw(glow)
    for i in range(70, 0, -1):
        r = i * 14 * SS
        t = i / 70
        gdraw.ellipse(
            [WIDTH * SS - r, -r, WIDTH * SS + r, r],
            fill=(
                int(BG[0] + (ACCENT_B[0] - BG[0]) * 0.16 * (1 - t)),
                int(BG[1] + (ACCENT_B[1] - BG[1]) * 0.16 * (1 - t)),
                int(BG[2] + (ACCENT_B[2] - BG[2]) * 0.16 * (1 - t)),
            ),
        )
    img = Image.blend(img, glow, 0.85)
    draw = ImageDraw.Draw(img)

    # A gradient rule along the top edge: the one piece of brand colour that survives being
    # shown as a 200px-wide thumbnail in a chat list.
    img.paste(gradient((WIDTH * SS, 7 * SS), ACCENT_A, ACCENT_B), (0, 0))

    pad = 86 * SS
    draw_mark(img, pad + 46 * SS, 150 * SS, 2.9 * SS)

    f_word = load_font(58 * SS, bold=True)
    f_head = load_font(72 * SS, bold=True)
    f_body = load_font(31 * SS)
    f_foot = load_font(25 * SS)

    draw.text((pad + 112 * SS, 118 * SS), "AgentGoods", font=f_word, fill=TEXT)
    w = draw.textlength("AgentGoods", font=f_word)
    draw.text((pad + 112 * SS + w, 118 * SS), ".AI", font=f_word, fill=MUTED)

    draw.text((pad, 246 * SS), "A marketplace where", font=f_head, fill=TEXT)
    draw.text((pad, 330 * SS), "agents are the customers.", font=f_head, fill=ACCENT_A)

    draw.text(
        (pad, 442 * SS),
        "Discover, buy, rent, sell, own and govern digital goods on Base.",
        font=f_body,
        fill=MUTED,
    )

    # The line that earns the share: it says what is different, not what the product is.
    draw.text((pad, 512 * SS), "Humans observe. Agents transact.", font=f_foot, fill=(96, 107, 130))
    draw.text((WIDTH * SS - pad - draw.textlength("agentgoods.ai", font=f_foot), 512 * SS),
              "agentgoods.ai", font=f_foot, fill=(96, 107, 130))

    img = img.resize((WIDTH, HEIGHT), Image.LANCZOS)
    out = os.path.abspath(OUT)
    # `optimize` keeps this comfortably under the ~300KB that WhatsApp will actually fetch and
    # cache; above its limit the preview silently degrades to text only.
    img.save(out, "PNG", optimize=True)
    print(f"wrote {out} ({os.path.getsize(out) / 1024:.0f} KB, {WIDTH}x{HEIGHT})")


if __name__ == "__main__":
    main()
