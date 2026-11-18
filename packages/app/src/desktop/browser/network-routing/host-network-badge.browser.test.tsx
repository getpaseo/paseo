import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { HostNetworkBadge } from "./host-network-badge";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
// Same flex as the pane's URL input: grows from a zero basis, so it has no width of its own.
const URL_FIELD_STYLE = { flex: "1 1 0px", minWidth: 0 };

afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  await i18n.changeLanguage("en");
});

function renderBadge(isRouted: boolean, hostLabel = "Remote Mac") {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root!.render(
      <I18nextProvider i18n={i18n}>
        <HostNetworkBadge isRouted={isRouted} serverId="remote" hostLabel={hostLabel} color="sky" />
      </I18nextProvider>,
    ),
  );
  return container;
}

describe("host network URL badge", () => {
  it("shows the routed host and removes the badge when routing is disabled", () => {
    const view = renderBadge(true);
    expect(view.textContent).toBe("via Remote Mac");
    expect(
      view.querySelector('[data-testid="host-badge-remote"]')?.getAttribute("aria-label"),
    ).toBe("via Remote Mac");
    renderBadge(false);
    expect(view.childElementCount).toBe(0);
  });

  it("appears on enable and follows host label changes", () => {
    const view = renderBadge(false);
    expect(view.childElementCount).toBe(0);
    renderBadge(true, "Build Host");
    expect(view.textContent).toBe("via Build Host");
    renderBadge(true, "Renamed Host");
    expect(view.textContent).toBe("via Renamed Host");
  });

  it("uses the selected language for the routing label", async () => {
    await i18n.changeLanguage("es");
    expect(renderBadge(true).textContent).toBe("vía Remote Mac");
  });

  it("truncates a long host name instead of squeezing the URL field beside it", () => {
    const bar = document.createElement("div");
    bar.style.display = "flex";
    bar.style.width = "300px";
    document.body.appendChild(bar);
    const barRoot = createRoot(bar);
    try {
      act(() =>
        barRoot.render(
          <I18nextProvider i18n={i18n}>
            <HostNetworkBadge
              isRouted
              serverId="remote"
              hostLabel="A build host whose name was never meant to fit in a URL bar"
              color="sky"
            />
            <div data-testid="url" style={URL_FIELD_STYLE} />
          </I18nextProvider>,
        ),
      );
      const wrap = bar.firstElementChild as HTMLElement;
      const url = bar.querySelector<HTMLElement>('[data-testid="url"]')!;
      expect(wrap.getBoundingClientRect().width).toBeLessThanOrEqual(100);
      expect(url.getBoundingClientRect().width).toBeGreaterThanOrEqual(200);
      const label = bar.querySelector<HTMLElement>('[data-testid="host-badge-remote"]')!
        .lastElementChild as HTMLElement;
      expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
      expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
    } finally {
      act(() => barRoot.unmount());
      bar.remove();
    }
  });
});
