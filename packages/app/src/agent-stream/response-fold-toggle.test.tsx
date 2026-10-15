/** @vitest-environment jsdom */
import React, { act, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { ResponseFoldToggle } from "./response-fold-toggle";

function ToggleExample({ count }: { count: number }) {
  const [expanded, setExpanded] = useState(false);
  const header = useMemo(() => ({ count, responseId: "answer", expanded }), [count, expanded]);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return <ResponseFoldToggle header={header} onToggle={toggle} />;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("response disclosure", () => {
  it.each([
    [1, "1 message"],
    [6, "6 messages"],
  ] as const)(
    "uses the French count %s and toggles without changing its label",
    async (count, label) => {
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      await i18n.changeLanguage("fr");
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        act(() =>
          root.render(
            <I18nextProvider i18n={i18n}>
              <ToggleExample count={count} />
            </I18nextProvider>,
          ),
        );
        const button = container.querySelector<HTMLElement>('[role="button"]');
        expect(button?.textContent).toBe(label);
        expect(button?.getAttribute("aria-expanded")).toBe("false");
        act(() => button!.click());
        expect(button?.textContent).toBe(label);
        expect(button?.getAttribute("aria-expanded")).toBe("true");
        act(() => button!.click());
        expect(button?.textContent).toBe(label);
        expect(button?.getAttribute("aria-expanded")).toBe("false");
      } finally {
        act(() => root.unmount());
        await i18n.changeLanguage("en");
      }
    },
  );
});
