#!/usr/bin/env python3
"""Regenerate Windows/Linux launchers with Pillow (maintainer tool only).

Install Pillow in a virtual environment, then run this script from any directory.
The existing macOS dark asset is the transparent, corrected Hasht mark. Crop its
mobile padding and fit its silhouette to ~90% of each desktop icon's width.
"""

from io import BytesIO
from pathlib import Path
import struct

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build/hasht.icon/Assets/hasht-dark.png"
# Win32 shell sizes, including intermediate display scales and Explorer views.
WINDOWS_SIZES = (16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256)


def render(mark, size):
    margin = max(1, round(size * 0.05))
    available = size - 2 * margin
    scale = available / max(mark.size)
    dimensions = tuple(round(value * scale) for value in mark.size)
    resized = mark.resize(dimensions, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size))
    canvas.alpha_composite(resized, ((size - resized.width) // 2,
                                    (size - resized.height) // 2))
    return canvas


def ico_payload(image):
    size = image.width
    if size == 256:
        stream = BytesIO()
        image.save(stream, format="PNG")
        return stream.getvalue()
    # Conventional 32-bit BGRA DIB entries for small sizes; PNG for 256px.
    pixels = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM).tobytes("raw", "BGRA")
    stride = ((size + 31) // 32) * 4
    mask = bytearray(stride * size)
    alpha = image.getchannel("A")
    for y in range(size):
        for x in range(size):
            if alpha.getpixel((x, y)) == 0:
                mask[(size - 1 - y) * stride + x // 8] |= 0x80 >> (x % 8)
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32,
                         0, len(pixels), 0, 0, 0, 0)
    return header + pixels + mask


def main():
    with Image.open(SOURCE) as source:
        mark = source.convert("RGBA")
    mark = mark.crop(mark.getchannel("A").getbbox())
    render(mark, 1024).save(ROOT / "build/icon.png")
    entries, payloads = [], []
    offset = 6 + 16 * len(WINDOWS_SIZES)
    for size in WINDOWS_SIZES:
        payload = ico_payload(render(mark, size))
        entries.append(struct.pack("<BBBBHHII", size % 256, size % 256,
                                   0, 0, 1, 32, len(payload), offset))
        payloads.append(payload)
        offset += len(payload)
    (ROOT / "build/icon.ico").write_bytes(
        struct.pack("<HHH", 0, 1, len(entries)) + b"".join(entries + payloads))


if __name__ == "__main__":
    main()
