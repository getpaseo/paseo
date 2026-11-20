import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Text } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { afterEach, expect, it, vi } from "vitest";
import { WindowLayoutProvider, WindowSafeArea } from "@/window-layout";

vi.stubGlobal("React", React);
const windowInsets = { top: 52, right: 0, bottom: 24, left: 0 };
const sheetTabInsets = { ...windowInsets, bottom: 0 };
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
});

function InsetsProbe({ testID }: { testID: string }) {
  const insets = useSafeAreaInsets();
  return <Text testID={testID}>{JSON.stringify(insets)}</Text>;
}

it("gives an overlay opened inside a sheet tab the window's insets", () => {
  act(() =>
    root.render(
      <SafeAreaInsetsContext.Provider value={windowInsets}>
        <WindowLayoutProvider>
          <SafeAreaInsetsContext.Provider value={sheetTabInsets}>
            <InsetsProbe testID="sheet-tab" />
            <WindowSafeArea>
              <InsetsProbe testID="overlay" />
            </WindowSafeArea>
          </SafeAreaInsetsContext.Provider>
        </WindowLayoutProvider>
      </SafeAreaInsetsContext.Provider>,
    ),
  );

  const insetsOf = (testID: string) =>
    JSON.parse(container.querySelector(`[data-testid="${testID}"]`)?.textContent ?? "null");
  expect(insetsOf("sheet-tab")).toEqual(sheetTabInsets);
  expect(insetsOf("overlay")).toEqual(windowInsets);
});
