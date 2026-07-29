#!/usr/bin/env python3

import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

root = Path(sys.argv[1] if len(sys.argv) > 1 else "candidate-validation")
report_path = root / "candidate-image-analysis.json"
results = []
failed = False

for filename in sorted(root.glob("*.png")):
    image = np.asarray(Image.open(filename).convert("RGB"), dtype=np.float32)
    height, width, _ = image.shape
    y0, y1 = int(height * 0.07), int(height * 0.93)
    x0, x1 = int(width * 0.07), int(width * 0.93)
    crop = image[y0:y1, x0:x1]

    brightness = crop.mean(axis=2)
    brightness_std = float(brightness.std())
    quantized = (crop // 16).astype(np.uint8)
    unique_colors = int(np.unique(quantized.reshape(-1, 3), axis=0).shape[0])

    vertical_diff = np.abs(crop[:, 1:, :] - crop[:, :-1, :]).mean(axis=2)
    horizontal_diff = np.abs(crop[1:, :, :] - crop[:-1, :, :]).mean(axis=2)
    vertical_coverage = (vertical_diff > 42).mean(axis=0)
    horizontal_coverage = (horizontal_diff > 42).mean(axis=1)
    vertical_mean = vertical_diff.mean(axis=0)
    horizontal_mean = horizontal_diff.mean(axis=1)

    suspicious_vertical = np.where((vertical_coverage > 0.72) & (vertical_mean > 28))[0].tolist()
    suspicious_horizontal = np.where((horizontal_coverage > 0.72) & (horizontal_mean > 28))[0].tolist()

    blank = brightness_std < 4.0 or unique_colors < 48
    seam_like = bool(suspicious_vertical or suspicious_horizontal)
    passed = not blank and not seam_like
    failed = failed or not passed

    results.append({
        "file": filename.name,
        "width": width,
        "height": height,
        "brightnessStd": round(brightness_std, 3),
        "quantizedUniqueColors": unique_colors,
        "suspiciousVerticalLines": suspicious_vertical[:20],
        "suspiciousHorizontalLines": suspicious_horizontal[:20],
        "blank": blank,
        "seamLike": seam_like,
        "passed": passed,
    })

report = {
    "generatedAt": os.environ.get("GITHUB_RUN_ID", "local"),
    "directory": str(root),
    "imageCount": len(results),
    "passed": bool(results) and not failed,
    "images": results,
}
report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

if not results:
    raise SystemExit("No candidate screenshots were found.")
if failed:
    raise SystemExit(f"Candidate screenshot analysis failed; see {report_path}.")
print(f"Validated {len(results)} candidate screenshots with no blank frames or axis-aligned seam signatures.")
