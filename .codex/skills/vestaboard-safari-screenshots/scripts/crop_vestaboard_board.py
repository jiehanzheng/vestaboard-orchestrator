#!/usr/bin/env python3

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def parse_rect(value: str) -> tuple[int, int, int, int]:
    parts = [int(part.strip()) for part in value.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("rectangle must be x0,y0,x1,y1")
    x0, y0, x1, y1 = parts
    if x1 <= x0 or y1 <= y0:
        raise argparse.ArgumentTypeError("rectangle must have positive width and height")
    return x0, y0, x1, y1


def is_board_pixel(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    luminance = (r + g + b) / 3
    saturation = max(pixel) - min(pixel)
    return luminance >= 28 or saturation > 30


def is_message_pixel(pixel: tuple[int, int, int]) -> bool:
    r, g, b = pixel
    luminance = (r + g + b) / 3
    saturation = max(pixel) - min(pixel)
    return luminance > 135 or saturation > 45


def projection_bounds(
    image: Image.Image,
    rough: tuple[int, int, int, int],
    span: tuple[int, int],
    axis: str,
    threshold: int,
) -> tuple[int, int]:
    x0, y0, x1, y1 = rough
    active: list[int] = []
    if axis == "x":
        yy0, yy1 = span
        for x in range(x0, x1):
            count = 0
            for y in range(yy0, yy1):
                if is_board_pixel(image.getpixel((x, y))):
                    count += 1
            if count > threshold:
                active.append(x)
    else:
        xx0, xx1 = span
        for y in range(y0, y1):
            count = 0
            for x in range(xx0, xx1):
                if is_board_pixel(image.getpixel((x, y))):
                    count += 1
            if count > threshold:
                active.append(y)

    if not active:
        raise SystemExit(f"Could not detect active board projection on {axis} axis")
    return min(active), max(active) + 1


def content_bounds(image: Image.Image, rough: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = rough
    xs: list[int] = []
    ys: list[int] = []
    for y in range(y0, y1):
        for x in range(x0, x1):
            if is_message_pixel(image.getpixel((x, y))):
                xs.append(x)
                ys.append(y)
    if not xs:
        raise SystemExit("Could not find message pixels inside rough rectangle")
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def detect_board(
    image: Image.Image,
    rough: tuple[int, int, int, int],
    rows: int,
    cols: int,
) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = rough
    cx0, cy0, cx1, cy1 = content_bounds(image, rough)
    x_pad = max(80, (cx1 - cx0) // cols)
    y_pad = max(60, (cy1 - cy0) // rows)
    x_span = (max(x0, cx0 - x_pad), min(x1, cx1 + x_pad))
    y_span = (max(y0, cy0 - y_pad), min(y1, cy1 + y_pad))

    x_threshold = max(5, (y_span[1] - y_span[0]) // 20)
    y_threshold = max(5, (x_span[1] - x_span[0]) // 20)
    bx0, bx1 = projection_bounds(image, rough, y_span, "x", x_threshold)
    by0, by1 = projection_bounds(image, rough, x_span, "y", y_threshold)

    width = bx1 - bx0
    height = by1 - by0
    if width <= 0 or height <= 0:
        raise SystemExit("Detected board rectangle has non-positive size")

    tile_w = width / cols
    tile_h = height / rows
    if tile_w < 20 or tile_h < 20:
        raise SystemExit(f"Detected tiles are implausibly small: {tile_w:.2f}x{tile_h:.2f}")

    aspect = tile_w / tile_h
    if not 0.45 <= aspect <= 1.2:
        raise SystemExit(
            f"Detected grid has implausible tile aspect {aspect:.3f} "
            f"for {cols}x{rows} board from {width}x{height}"
        )

    return bx0, by0, bx1, by1


def main() -> None:
    parser = argparse.ArgumentParser(description="Crop a Safari Vestaboard screenshot to exact board bounds.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--rough", required=True, type=parse_rect, help="Loose board rectangle as x0,y0,x1,y1 in screenshot pixels")
    parser.add_argument("--rows", required=True, type=int)
    parser.add_argument("--cols", required=True, type=int)
    parser.add_argument("--pad-x", type=int, default=0, help="Pixels to retain left and right outside detected board bounds")
    parser.add_argument("--pad-y", type=int, default=0, help="Pixels to retain above and below detected board bounds")
    parser.add_argument("--expect-width", type=int, help="Fail unless the output width matches this value")
    parser.add_argument("--expect-height", type=int, help="Fail unless the output height matches this value")
    args = parser.parse_args()

    image = Image.open(args.input).convert("RGB")
    bx0, by0, bx1, by1 = detect_board(image, args.rough, args.rows, args.cols)
    crop = (
        max(0, bx0 - args.pad_x),
        max(0, by0 - args.pad_y),
        min(image.width, bx1 + args.pad_x),
        min(image.height, by1 + args.pad_y),
    )
    output = image.crop(crop)
    if args.expect_width is not None and output.width != args.expect_width:
        raise SystemExit(f"Expected width {args.expect_width}; got {output.width} from crop={crop}")
    if args.expect_height is not None and output.height != args.expect_height:
        raise SystemExit(f"Expected height {args.expect_height}; got {output.height} from crop={crop}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output)
    print(f"crop={crop} size={output.size} grid={args.cols}x{args.rows} output={args.output}")


if __name__ == "__main__":
    main()
