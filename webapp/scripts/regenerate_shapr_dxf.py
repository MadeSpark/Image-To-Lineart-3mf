from pathlib import Path

import cv2
import ezdxf
import numpy as np
from PIL import Image


MAX_DIMENSION = 720
DXF_TARGET_MAX_SIZE = 200
DXF_TRACE_MAX_DIMENSION = 192
MIN_CONTOUR_AREA = 6.0
APPROX_RATIO = 0.01


def build_dxf(image_path: Path, output_path: Path, color_count: int = 5):
    image = Image.open(image_path).convert("RGBA")
    scale = min(1.0, MAX_DIMENSION / max(image.size))
    if scale < 1.0:
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )

    quantized = image.convert("RGB").quantize(colors=color_count, method=Image.Quantize.MEDIANCUT).convert("RGBA")
    if max(quantized.size) > DXF_TRACE_MAX_DIMENSION:
        scale = DXF_TRACE_MAX_DIMENSION / max(quantized.size)
        quantized = quantized.resize(
            (max(1, round(quantized.width * scale)), max(1, round(quantized.height * scale))),
            Image.Resampling.NEAREST,
        )

    width, height = quantized.size
    rgba = quantized.load()
    palette = sorted({rgba[x, y][:3] for y in range(height) for x in range(width) if rgba[x, y][3] >= 8})
    model_scale = DXF_TARGET_MAX_SIZE / max(width, height, 1)
    model_height = height * model_scale

    doc = ezdxf.new("R12")
    doc.header["$INSBASE"] = (0.0, 0.0, 0.0)
    doc.header["$EXTMIN"] = (0.0, 0.0, 0.0)
    doc.header["$EXTMAX"] = (width * model_scale, model_height, 0.0)
    msp = doc.modelspace()

    polyline_count = 0
    for color in palette:
        mask = Image.new("L", (width, height), 0)
        mask_px = mask.load()
        for y in range(height):
            for x in range(width):
                mask_px[x, y] = 255 if rgba[x, y][3] >= 8 and rgba[x, y][:3] == color else 0

        mask_array = cv2.medianBlur(np.array(mask, dtype=np.uint8), 3)
        contours, _ = cv2.findContours(mask_array, cv2.RETR_LIST, cv2.CHAIN_APPROX_TC89_KCOS)

        for contour in contours:
            area = cv2.contourArea(contour)
            if area < MIN_CONTOUR_AREA:
                continue

            epsilon = max(0.8, cv2.arcLength(contour, True) * APPROX_RATIO)
            approx = cv2.approxPolyDP(contour, epsilon, True)
            if len(approx) < 3:
                continue

            points = []
            for point in approx[:, 0, :]:
                x, y = float(point[0]), float(point[1])
                points.append((x * model_scale, model_height - y * model_scale))

            polyline = msp.add_polyline2d(points, dxfattribs={"layer": "0"})
            polyline.close(True)
            polyline_count += 1

    doc.saveas(output_path)
    return polyline_count


if __name__ == "__main__":
    image_path = Path(r"c:\Users\MadeSpark\Desktop\新增資料夾\动画\B_000_125.png")
    output_path = Path(r"c:\Users\MadeSpark\Desktop\新增資料夾\webapp\dist\B_000_125-shapr-sketch.dxf")
    segment_count = build_dxf(image_path, output_path)
    print(output_path)
    print(f"segments={segment_count}")
