/** @vitest-environment jsdom */
import { expect, it } from "vitest";
import { inertArtifactHtml } from "./html-policy";
import { renderArtifact } from "./runtime/render";
it("keeps generated JavaScript inert and removes navigation and host/network entry points", () => {
  const result = inertArtifactHtml(
    '<html><body><script>fetch("https://evil")</script><a href="https://evil">go</a><form action="https://evil"><input></form><img src="https://evil"><meta http-equiv="refresh" content="0;url=https://evil"><iframe src="file:///etc/passwd"></iframe><div onclick="location.href=\'https://evil\'">ok</div></body></html>',
  );
  expect(result.scripted).toBe(true);
  expect(result.html).not.toContain("evil");
  expect(result.html).not.toContain("onclick");
  expect(result.html).not.toContain("<script");
  expect(result.html).toContain("script-src 'none'");
  expect(result.html).toContain("<div>ok</div>");
});

it("keeps styles, SVG namespaces and controls through sanitized DOM updates", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const markup = (count: number) => `<style>.chart { color: navy }</style>
    <section class="chart" style="padding: 8px" aria-label="Chart">
      <svg viewBox="0 0 100 40"><g><rect width="${count}" height="20" fill="navy"/><text x="2" y="12">${count}</text></g></svg>
      <button id="add" type="button">Add ${count}</button>
      <input id="amount" type="range" min="0" max="20" step="1" value="${count}">
      <textarea id="note" placeholder="Note">Hello</textarea>
      <select id="choice"><option value="a" selected>A</option><option value="b">B</option></select>
    </section>`;
  try {
    renderArtifact(root, markup(2));
    const slider = root.querySelector<HTMLInputElement>("#amount")!;
    const note = root.querySelector<HTMLTextAreaElement>("#note")!;
    note.focus();
    note.setSelectionRange(1, 3);
    let clicks = 0;
    root.addEventListener("click", () => {
      clicks++;
    });
    renderArtifact(root, markup(12));
    expect(root.querySelector("#amount")).toBe(slider);
    expect(slider.value).toBe("12");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("20");
    expect(root.querySelector("#note")).toBe(note);
    expect(document.activeElement).toBe(note);
    expect([note.selectionStart, note.selectionEnd]).toEqual([1, 3]);
    expect(root.querySelector("style")!.textContent).toContain("color: navy");
    expect(root.querySelector<HTMLElement>("section")!.style.padding).toBe("8px");
    expect(root.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 100 40");
    expect(root.querySelector("rect")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.querySelector("rect")!.getAttribute("width")).toBe("12");
    expect(root.querySelector<HTMLSelectElement>("#choice")!.value).toBe("a");
    root.querySelector<HTMLButtonElement>("#add")!.click();
    expect(clicks).toBe(1);
  } finally {
    root.remove();
  }
});

it("applies the positive DOM policy on every render using inert out-of-policy nodes", () => {
  const root = document.createElement("div");
  const markup =
    '<section data-extra="discard" aria-hidden="true"><p title="Keep">Text</p><a>Label</a><form></form><iframe></iframe><meta name="note" content="inert"><svg><circle r="4"/><foreignObject><p>Unused</p></foreignObject></svg><img alt="Empty"><input type="text" placeholder="Note"></section>';
  for (let update = 0; update < 2; update++) {
    renderArtifact(root, markup);
    expect(root.querySelector("a,form,iframe,meta,foreignObject")).toBeNull();
    expect(root.querySelector("[data-extra],[aria-hidden]")).toBeNull();
    expect(root.querySelector("p[title]")!.textContent).toBe("Text");
    expect(root.querySelector("circle")!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(root.querySelector("img")!.getAttribute("src")).toBeNull();
    expect(root.querySelector("input")!.getAttribute("placeholder")).toBe("Note");
  }
});
