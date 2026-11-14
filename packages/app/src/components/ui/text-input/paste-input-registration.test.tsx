// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  registerTextInput: vi.fn(),
  unregisterTextInput: vi.fn(),
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    Platform: { OS: "ios" },
    TurboModuleRegistry: { getEnforcing: () => native },
    NativeEventEmitter: class {
      addListener() {
        return { remove() {} };
      }
    },
    TextInput: ReactModule.forwardRef<unknown, { onFocus?: () => void }>((props, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({ __nativeTag: 42 }), []);
      return ReactModule.createElement("input", { onFocus: props.onFocus });
    }),
  };
});
vi.mock("@mattermost/react-native-paste-input/src/PasteTextInput", () => ({ default: () => null }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __DEV__: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// iOS Fabric recycles the native text view of a composer hidden with `display: none` and hands
// it to another composer while both stay mounted in React. The mount-time registration then
// points at a view that belongs to someone else, so the focused input must claim its view again.
it("re-registers the iOS paste input with the native module when it gains focus", async () => {
  // The package's `main` build requires the real react-native, so load its source through Vite.
  // A computed specifier keeps the library's own sources out of this project's typecheck.
  const source = "@mattermost/react-native-paste-input/src/PasteInput";
  const { default: PasteInput } = (await import(/* @vite-ignore */ source)) as {
    default: typeof import("@mattermost/react-native-paste-input").default;
  };
  const onFocus = vi.fn();
  act(() => root.render(<PasteInput onPaste={vi.fn()} onFocus={onFocus} />));
  // Mount registers the input and applies its config.
  const registrationsAtMount = native.registerTextInput.mock.calls.length;
  expect(registrationsAtMount).toBeGreaterThan(0);

  act(() => container.querySelector("input")?.focus());

  expect(native.registerTextInput).toHaveBeenCalledTimes(registrationsAtMount + 1);
  expect(native.registerTextInput).toHaveBeenLastCalledWith("PasteInput_42", expect.anything());
  expect(onFocus).toHaveBeenCalledOnce();
});
