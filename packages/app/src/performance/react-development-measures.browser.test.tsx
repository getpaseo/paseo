import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";

let setLabel: (label: string) => void = () => {};

function Row({ label }: { label: string }) {
  return <div>{label}</div>;
}

function List() {
  const [label, setState] = useState("first");
  setLabel = setState;
  return <Row label={label} />;
}

function reactMeasures(): PerformanceEntry[] {
  return performance
    .getEntriesByType("measure")
    .filter((entry) => JSON.stringify((entry as PerformanceMeasure).detail ?? "").includes("⚛"));
}

// React's development build reports renders to the browser's performance timeline. The browser
// keeps every measure for the life of the page, so a long session held millions of them.
test("React's development render timings do not pile up in the performance timeline", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<List />));
    for (const label of ["second", "third", "fourth"]) {
      await act(async () => setLabel(label));
    }

    expect(container.textContent).toBe("fourth");
    expect(reactMeasures()).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
