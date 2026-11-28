"""Check native drop recordings against visible row labels (requires opencv-python-headless).

Supply a before screenshot and a JSON map of label names to [x, y, width, height].
A recording must start in the original order and end in a different order. Once
all labels reach their final slots, any frame returning to the original slots fails.
Keep the pointer clear of the labels and use fixed fixture data.
"""
import argparse
import json
from pathlib import Path

import cv2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--reference", required=True)
parser.add_argument("--labels", required=True)
parser.add_argument("--top", type=int, default=0)
parser.add_argument("--bottom", type=int)
parser.add_argument("videos", nargs="+")
args = parser.parse_args()
reference = cv2.imread(args.reference, cv2.IMREAD_GRAYSCALE)
assert reference is not None, "Cannot read reference image"
labels = json.loads(Path(args.labels).read_text())
results = []
for video in args.videos:
    capture = cv2.VideoCapture(video)
    frames = []
    while True:
        ok, image = capture.read()
        if not ok:
            break
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        positions = {}
        for label, (x, y, width, height) in labels.items():
            template = reference[y:y + height, x:x + width]
            matches = cv2.matchTemplate(gray[args.top:args.bottom, x:x + width], template, cv2.TM_CCOEFF_NORMED)
            _, confidence, _, point = cv2.minMaxLoc(matches)
            positions[label] = (point[1] + args.top, confidence)
        frames.append(positions)
    capture.release()
    assert frames, f"No frames in {video}"
    initial, final = frames[0], frames[-1]
    assert all(confidence >= 0.95 for _, confidence in initial.values()), f"Unrecognized initial labels: {video}"
    assert all(confidence >= 0.95 for _, confidence in final.values()), f"Unrecognized final labels: {video}"
    assert sorted(initial, key=lambda key: initial[key][0]) != sorted(final, key=lambda key: final[key][0]), f"Drop did not reorder: {video}"

    def matches_slots(frame, target):
        return all(confidence >= 0.95 and abs(y - target[label][0]) <= 2
                   for label, (y, confidence) in frame.items())

    reached_final = False
    wrong = []
    for number, frame in enumerate(frames, start=1):
        reached_final = reached_final or matches_slots(frame, final)
        if reached_final and matches_slots(frame, initial):
            wrong.append(number)
    results.append({"recording": video, "oldOrderFrames": wrong, "count": len(wrong)})
print(json.dumps(results, indent=2))
raise SystemExit(1 if any(result["count"] for result in results) else 0)
