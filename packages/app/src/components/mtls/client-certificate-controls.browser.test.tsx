import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClientCertificateControls,
  type ClientCertificateApi,
} from "./client-certificate-controls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(certificates: ClientCertificateApi) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ClientCertificateControls host="example.invalid" port={8444} certificates={certificates} />,
    ),
  );
}

async function press(id: string) {
  const button = document.querySelector(`[data-testid="${id}"]`);
  if (!(button instanceof HTMLElement)) throw new Error(`Missing button: ${id}`);
  await act(async () => button.click());
}

describe("client certificate selection", () => {
  it("shows a saved selection, updates it and removes only its origin's assignment", async () => {
    const assignments = new Map([
      ["example.invalid:8444", "Synthetic Certificate A"],
      ["other.invalid:443", "Other Certificate"],
    ]);
    mount({
      selected: (host, port) => assignments.get(`${host}:${port}`) ?? null,
      choose: async (host, port) => {
        assignments.set(`${host}:${port}`, "Synthetic Certificate B");
        return "Synthetic Certificate B";
      },
      remove: async (host, port) => {
        assignments.delete(`${host}:${port}`);
      },
    });
    expect(container!.textContent).toContain("Synthetic Certificate A");
    await press("client-certificate-choose");
    expect(container!.textContent).toContain("Synthetic Certificate B");
    await press("client-certificate-remove");
    expect(container!.textContent).not.toContain("Synthetic Certificate B");
    expect(assignments).toEqual(new Map([["other.invalid:443", "Other Certificate"]]));
  });

  it("keeps the previous selection on cancellation and displays failures with retry available", async () => {
    let attempt = 0;
    mount({
      selected: () => "Synthetic Certificate A",
      choose: async () => {
        if (++attempt === 1) return null;
        throw new Error("Certificate is unavailable. Choose again.");
      },
      remove: async () => {
        throw new Error("Selection could not be removed.");
      },
    });
    await press("client-certificate-choose");
    expect(container!.textContent).toContain("Synthetic Certificate A");
    await press("client-certificate-choose");
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      "Certificate is unavailable. Choose again.",
    );
    expect(
      container!
        .querySelector('[data-testid="client-certificate-choose"]')
        ?.getAttribute("aria-disabled"),
    ).not.toBe("true");
    await press("client-certificate-remove");
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      "Selection could not be removed.",
    );
    expect(container!.textContent).toContain("Synthetic Certificate A");
  });

  it("prevents duplicate selection while the picker is pending", async () => {
    let finish!: (alias: string | null) => void;
    mount({
      selected: () => null,
      choose: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      remove: async () => {},
    });
    await press("client-certificate-choose");
    expect(
      container!
        .querySelector('[data-testid="client-certificate-choose"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    await act(async () => finish("Synthetic Certificate C"));
    expect(container!.textContent).toContain("Synthetic Certificate C");
  });
});
