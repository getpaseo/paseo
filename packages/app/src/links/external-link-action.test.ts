import { describe, expect, it } from "vitest";
import {
  readExternalLinkClick,
  resolveExternalLinkAction,
  type ExternalLinkAction,
  type ExternalLinkActionInput,
} from "./external-link-action";

const cases: Array<[string, ExternalLinkActionInput, ExternalLinkAction]> = [
  [
    "plain click shows the popover",
    { primaryModifier: false, shift: false, popoverEnabled: true, paseoBrowserAvailable: true },
    "show-popover",
  ],
  [
    "plain click opens the system browser when the popover is off",
    { primaryModifier: false, shift: false, popoverEnabled: false, paseoBrowserAvailable: true },
    "open-in-system-browser",
  ],
  [
    "shift click alone behaves like a plain click",
    { primaryModifier: false, shift: true, popoverEnabled: true, paseoBrowserAvailable: true },
    "show-popover",
  ],
  [
    "primary click opens the Paseo browser",
    { primaryModifier: true, shift: false, popoverEnabled: true, paseoBrowserAvailable: true },
    "open-in-paseo-browser",
  ],
  [
    "primary click opens the Paseo browser when the popover is off",
    { primaryModifier: true, shift: false, popoverEnabled: false, paseoBrowserAvailable: true },
    "open-in-paseo-browser",
  ],
  [
    "shift primary click opens the system browser",
    { primaryModifier: true, shift: true, popoverEnabled: true, paseoBrowserAvailable: true },
    "open-in-system-browser",
  ],
  [
    "any click opens the system browser without a Paseo browser",
    { primaryModifier: false, shift: false, popoverEnabled: true, paseoBrowserAvailable: false },
    "open-in-system-browser",
  ],
  [
    "primary click opens the system browser without a Paseo browser",
    { primaryModifier: true, shift: false, popoverEnabled: true, paseoBrowserAvailable: false },
    "open-in-system-browser",
  ],
];

describe("resolveExternalLinkAction", () => {
  it.each(cases)("%s", (_name, input, expected) => {
    expect(resolveExternalLinkAction(input)).toBe(expected);
  });
});

describe("readExternalLinkClick", () => {
  const event = { clientX: 40, clientY: 80, metaKey: true, ctrlKey: false, shiftKey: true };

  it("reads Cmd as the primary modifier on macOS", () => {
    expect(readExternalLinkClick({ url: "https://example.com", event, isMac: true })).toEqual({
      url: "https://example.com",
      clientX: 40,
      clientY: 80,
      primaryModifier: true,
      shift: true,
    });
  });

  it("reads Ctrl as the primary modifier elsewhere", () => {
    const ctrlClick = { ...event, metaKey: false, ctrlKey: true };
    expect(
      readExternalLinkClick({ url: "https://example.com", event, isMac: false }).primaryModifier,
    ).toBe(false);
    expect(
      readExternalLinkClick({ url: "https://example.com", event: ctrlClick, isMac: false })
        .primaryModifier,
    ).toBe(true);
  });
});
