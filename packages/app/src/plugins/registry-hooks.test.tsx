/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock("./evaluate", () => ({
  evaluatePluginClientBundle: vi.fn(),
}));
vi.mock("./composer-pills/lifecycle", () => ({
  startPluginClientSide: vi.fn(),
}));

import { usePluginInstallations } from "./registry";

it("keeps plugin installation selections stable while the registry is unchanged", () => {
  const { result, rerender } = renderHook(() => usePluginInstallations("missing-plugin"));
  const initialInstallations = result.current;

  rerender();

  expect(result.current).toBe(initialInstallations);
});
