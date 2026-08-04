from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "src-tauri" / "icons"


def render(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    margin = max(1, round(size * 0.035))
    draw.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=round(size * 0.19),
        fill="#101010",
    )

    left = round(size * 0.285)
    right = round(size * 0.725)
    top = round(size * 0.265)
    thickness = max(2, round(size * 0.095))
    middle_width = round((right - left) * 0.78)
    bottom = round(size * 0.735)
    fill = "#F2F2EE"

    draw.rounded_rectangle((left, top, right, top + thickness), radius=thickness // 3, fill=fill)
    draw.rounded_rectangle(
        (left, round(size * 0.455), left + middle_width, round(size * 0.455) + thickness),
        radius=thickness // 3,
        fill=fill,
    )
    draw.rounded_rectangle((left, bottom - thickness, right, bottom), radius=thickness // 3, fill=fill)
    draw.rounded_rectangle((left, top, left + thickness, bottom), radius=thickness // 3, fill=fill)
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
