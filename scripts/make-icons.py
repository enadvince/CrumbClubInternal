"""Generates the PWA icons in public/. Run: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw, ImageFont

CARAMEL = (154, 79, 18)
CREAM = (255, 248, 239)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"

def icon(size, maskable=False):
    img = Image.new("RGB", (size, size), CARAMEL if maskable else CREAM)
    d = ImageDraw.Draw(img)
    if not maskable:
        r = int(size * 0.22)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=CARAMEL)
    font = ImageFont.truetype(FONT, int(size * (0.34 if maskable else 0.42)))
    text = "CC"
    box = d.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), text, font=font, fill=CREAM)
    return img

for s in (192, 512):
    icon(s).save(f"public/icon-{s}.png")
icon(512, maskable=True).save("public/icon-maskable-512.png")
icon(180).save("public/apple-touch-icon.png")
