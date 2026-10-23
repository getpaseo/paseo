"""Render the frozen numeric samples: python3 plot-live-usage.py (requires matplotlib)."""

import csv
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

directory = Path(__file__).resolve().parent
with (directory / "live-usage-samples.csv").open() as source:
    samples = list(csv.DictReader(source))
summary = json.loads((directory / "live-usage-summary.json").read_text())
hours = [float(row["uptimeSeconds"]) / 3600 for row in samples]

figure, (main, low) = plt.subplots(
    2,
    1,
    figsize=(10, 5.8),
    sharex=True,
    gridspec_kw={"height_ratios": [2, 1]},
    layout="constrained",
)
figure.suptitle("Paseo with JSONL fix — contributor live usage", fontweight="bold", fontsize=13)
main.plot(hours, [float(row["rssMiB"]) for row in samples], label="RSS", color="#94a3b8")
main.plot(hours, [float(row["heapMiB"]) for row in samples], label="V8 heap used", color="#2563eb")
main.axvspan(0, 0.25, color="#fbbf24", alpha=0.13, label="Startup / history restore")
main.set_ylabel("MiB")
main.set_ylim(bottom=0)
main.grid(alpha=0.18)
main.legend(frameon=False, loc="upper right")

complete_windows = [
    row for row in summary["lowWaterWindows"]
    if row["uptimeMinutes"] >= 15
    and (row["uptimeMinutes"] + 15) * 60 <= float(samples[-1]["uptimeSeconds"])
]
low.plot(
    [(row["uptimeMinutes"] + 7.5) / 60 for row in complete_windows],
    [row["minHeapMiB"] for row in complete_windows],
    marker="o",
    color="#059669",
    label="Completed 15-min heap low-water",
)
low.set_ylabel("MiB")
low.set_xlabel("Worker uptime (hours)")
low.set_ylim(125, 155)
low.grid(alpha=0.18)
low.legend(frameon=False, loc="upper left", fontsize=9)
figure.supxlabel(
    "Natural GC; variable workload. Samples every ~30 seconds; no forced collections.",
    fontsize=9,
    color="#475569",
)
figure.savefig(directory / "live-usage.png", dpi=160)
