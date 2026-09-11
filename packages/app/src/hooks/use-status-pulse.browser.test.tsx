import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Animated from "react-native-reanimated";
import { afterEach, expect, it, vi } from "vitest";
import { useStatusPulse } from "./use-status-pulse";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

// Only the OS preference is substituted; the browser runs the real animation.
const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("react-native-reanimated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native-reanimated")>()),
  useReducedMotion: () => preference.reduced,
}));

// Metro resolves these CommonJS imports; Vite's unbundled Reanimated path does not.
vi.mock("react-native-reanimated/lib/module/ReanimatedModule/js-reanimated/webUtils", async () => {
  const compiler = await vi.importActual<{ default: unknown }>(
    "react-native-web/dist/exports/StyleSheet/compiler/createReactDOMStyle",
  );
  const preprocess = await vi.importActual<Record<string, unknown>>(
    "react-native-web/dist/exports/StyleSheet/preprocess",
  );
  return {
    createReactDOMStyle: compiler.default,
    createTransformValue: preprocess.createTransformValue,
    createTextShadowValue: preprocess.createTextShadowValue,
  };
});

let root: Root | undefined;
let container: HTMLDivElement;

function Badge({ bucket, timestamp }: { bucket: SidebarStateBucket; timestamp?: number }) {
  const style = useStatusPulse(bucket, timestamp);
  return <Animated.View testID="badge" style={style} />;
}

function render(bucket: SidebarStateBucket, timestamp?: number) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<Badge bucket={bucket} timestamp={timestamp} />));
}

function opacity() {
  const badge = container.querySelector('[data-testid="badge"]');
  if (!badge) throw new Error("Missing badge");
  return Number(getComputedStyle(badge).opacity);
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  preference.reduced = false;
});

it("pulses recent attention, expires at its original deadline, and stays solid after remount", async () => {
  const timestamp = Date.now() - 58_500;
  render("attention", timestamp);
  await expect.poll(opacity).toBeLessThan(0.9);
  await expect.poll(opacity, { timeout: 2500 }).toBe(1);
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  render("attention", timestamp);
  expect(opacity()).toBe(1);
});

it("stops when the state clears and starts for a new question", async () => {
  const timestamp = Date.now();
  render("needs_input", timestamp);
  await expect.poll(opacity).toBeLessThan(0.9);
  render("done", timestamp);
  await expect.poll(opacity).toBe(1);
  render("needs_input", Date.now());
  await expect.poll(opacity).toBeLessThan(0.9);
});

it.each([undefined, Number.NaN, Date.now() - 120_000])(
  "keeps absent, invalid, and old timestamps solid (%s)",
  async (timestamp) => {
    render("attention", timestamp);
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(opacity()).toBe(1);
  },
);

it("keeps recent badges solid with reduced motion", async () => {
  preference.reduced = true;
  render("needs_input", Date.now());
  await new Promise((resolve) => setTimeout(resolve, 850));
  expect(opacity()).toBe(1);
});
