import { describe, expect, test } from "vitest";
import { classifyBrowserReservedShortcut, parseBrowserKeyboardPolicy } from "./policy.js";

describe("browser keyboard policy", () => {
  test("classifies shell-owned browser shortcuts for the current platform modifier", () => {
    const macInputs = [
      { type: "keyDown", key: "t", meta: true, control: false, alt: false, shift: false },
      { type: "keyDown", key: "l", meta: true, control: false, alt: false, shift: false },
      { type: "keyDown", key: "r", meta: true, control: false, alt: false, shift: false },
      { type: "keyDown", key: "r", meta: true, control: false, alt: false, shift: true },
    ];
    const nonMacInputs = macInputs.map((input) => ({
      ...input,
      control: true,
      meta: false,
    }));

    expect(
      macInputs.map((input) => classifyBrowserReservedShortcut(input, { isMac: true })),
    ).toEqual(["new-tab", "focus-url", "reload", "force-reload"]);
    expect(
      nonMacInputs.map((input) => classifyBrowserReservedShortcut(input, { isMac: false })),
    ).toEqual(["new-tab", "focus-url", "reload", "force-reload"]);
  });

  test("rejects the wrong or ambiguous command modifier for reserved shortcuts", () => {
    const input = {
      type: "keyDown",
      key: "t",
      meta: false,
      control: true,
      alt: false,
      shift: false,
    };

    expect(classifyBrowserReservedShortcut(input, { isMac: true })).toBeNull();
    expect(
      classifyBrowserReservedShortcut({ ...input, meta: true, control: false }, { isMac: false }),
    ).toBeNull();
    expect(
      classifyBrowserReservedShortcut({ ...input, meta: true, control: true }, { isMac: true }),
    ).toBeNull();
    expect(
      classifyBrowserReservedShortcut({ ...input, meta: true, control: true }, { isMac: false }),
    ).toBeNull();
    expect(
      classifyBrowserReservedShortcut(
        { ...input, key: "r", meta: true, control: false, alt: true },
        { isMac: true },
      ),
    ).toBeNull();
    expect(
      classifyBrowserReservedShortcut(
        { ...input, meta: true, control: false, shift: true },
        { isMac: true },
      ),
    ).toBeNull();
  });

  test("accepts only complete modifier prefixes from the host renderer", () => {
    expect(
      parseBrowserKeyboardPolicy({
        prefixes: [
          { code: "KeyB", control: true, meta: false, alt: false, repeat: false, shift: false },
        ],
      }),
    ).toEqual({
      prefixes: [
        { code: "KeyB", control: true, meta: false, alt: false, repeat: false, shift: false },
      ],
    });
    expect(parseBrowserKeyboardPolicy({ prefixes: [{ code: "KeyB", control: true }] })).toBeNull();
  });
});
