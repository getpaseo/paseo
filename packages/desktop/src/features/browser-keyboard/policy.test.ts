import { describe, expect, test } from "vitest";
import {
  classifyBrowserReservedShortcut,
  matchesBrowserShortcutPolicy,
  parseBrowserKeyboardPolicy,
  parseBrowserShortcutInput,
} from "./policy.js";

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
    ).toEqual([null, "focus-url", "reload", "force-reload"]);
    expect(
      nonMacInputs.map((input) => classifyBrowserReservedShortcut(input, { isMac: false })),
    ).toEqual([null, "focus-url", "reload", "force-reload"]);
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
        menuPrefixes: [
          { code: "KeyB", control: true, meta: false, alt: false, repeat: false, shift: false },
        ],
        prefixes: [
          { code: "KeyB", control: true, meta: false, alt: false, repeat: false, shift: false },
        ],
      }),
    ).toEqual({
      menuPrefixes: [
        { code: "KeyB", control: true, meta: false, alt: false, repeat: false, shift: false },
      ],
      prefixes: [
        { code: "KeyB", control: true, meta: false, alt: false, repeat: false, shift: false },
      ],
    });
    expect(parseBrowserKeyboardPolicy({ prefixes: [{ code: "KeyB", control: true }] })).toBeNull();
  });

  test("rejects a false code fallback instead of treating it as absent", () => {
    expect(
      parseBrowserKeyboardPolicy({
        menuPrefixes: [],
        prefixes: [
          {
            alt: false,
            code: "KeyB",
            codeFallback: false,
            control: true,
            meta: false,
            shift: false,
          },
        ],
      }),
    ).toBeNull();
  });

  test("preserves editable exclusions and rejects permissive values", () => {
    expect(
      parseBrowserKeyboardPolicy({
        menuPrefixes: [],
        prefixes: [
          {
            alt: false,
            code: "ArrowLeft",
            control: false,
            editable: false,
            meta: true,
            shift: true,
          },
        ],
      }),
    ).toEqual({
      menuPrefixes: [],
      prefixes: [
        {
          alt: false,
          code: "ArrowLeft",
          control: false,
          editable: false,
          meta: true,
          shift: true,
        },
      ],
    });
    expect(
      parseBrowserKeyboardPolicy({
        menuPrefixes: [],
        prefixes: [
          {
            alt: false,
            code: "ArrowLeft",
            control: false,
            editable: true,
            meta: true,
            shift: true,
          },
        ],
      }),
    ).toBeNull();

    const policy = parseBrowserKeyboardPolicy({
      menuPrefixes: [],
      prefixes: [
        {
          alt: false,
          code: "ArrowLeft",
          control: false,
          editable: false,
          meta: true,
          shift: true,
        },
      ],
    });
    const input = {
      alt: false,
      code: "ArrowLeft",
      control: false,
      key: "ArrowLeft",
      meta: true,
      repeat: false,
      shift: true,
    };
    expect(matchesBrowserShortcutPolicy(policy!, { ...input, editable: false })).toBe(true);
    expect(matchesBrowserShortcutPolicy(policy!, { ...input, editable: true })).toBe(false);
  });

  test("keeps browser identities exact", () => {
    expect(
      parseBrowserShortcutInput({
        alt: false,
        browserId: " browser-1 ",
        code: "KeyB",
        control: true,
        key: "b",
        meta: false,
        shift: false,
      }),
    ).toMatchObject({ browserId: " browser-1 " });
  });

  test("matches digit shortcuts for the top row and numeric keypad", () => {
    const policy = parseBrowserKeyboardPolicy({
      menuPrefixes: [],
      prefixes: [
        { alt: false, code: "Digit", control: true, meta: false, repeat: false, shift: false },
      ],
    });
    expect(policy).not.toBeNull();

    expect(
      matchesBrowserShortcutPolicy(policy!, {
        alt: false,
        code: "Digit3",
        control: true,
        key: "3",
        meta: false,
        repeat: false,
        shift: false,
      }),
    ).toBe(true);
    expect(
      matchesBrowserShortcutPolicy(policy!, {
        alt: false,
        code: "Numpad3",
        control: true,
        key: "3",
        meta: false,
        repeat: false,
        shift: false,
      }),
    ).toBe(true);
    expect(
      matchesBrowserShortcutPolicy(policy!, {
        alt: false,
        code: "Digit0",
        control: true,
        key: "0",
        meta: false,
        repeat: false,
        shift: false,
      }),
    ).toBe(false);
  });
});
