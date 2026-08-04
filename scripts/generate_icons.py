from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri" / "icons"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def render(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    margin = round(size * 0.035)
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=round(size * 0.22),
        fill="#090909",
    )
    font = ImageFont.truetype(FONT, round(size * 0.72))
    box = draw.textbbox((0, 0), "e", font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    draw.text(
        ((size - width) / 2, (size - height) / 2 - box[1] - size * 0.018),
        "e",
        font=font,
        fill="#F5F5F5",
    )
    return image


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    render(32).save(ICON_DIR / "32x32.png")
    render(128).save(ICON_DIR / "128x128.png")
    render(256).save(ICON_DIR / "128x128@2x.png")
    render(256).save(
        ICON_DIR / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
