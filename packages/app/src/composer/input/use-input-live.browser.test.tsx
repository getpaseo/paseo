import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useIsInputLive } from "./use-input-live";

// App sources compile against the classic JSX runtime, which expects React on the global, as the
// other browser tests here arrange.
beforeEach(() => vi.stubGlobal("React", React));

interface InputRef {
  current: object | null;
}

function render(active: boolean, input: InputRef, publish: (isLive: () => boolean) => void) {
  function Probe() {
    publish(useIsInputLive(input));
    return null;
  }
  return (
    <RetainedPanelActivity active={active}>
      <Probe />
    </RetainedPanelActivity>
  );
}

it("an input kept mounted in a panel that is not showing is not live", () => {
  const input: InputRef = { current: {} };
  let isLive: () => boolean = () => false;
  const publish = (read: () => boolean) => {
    isLive = read;
  };
  const root = createRoot(document.createElement("div"));

  act(() => root.render(render(true, input, publish)));
  expect(isLive()).toBe(true);

  act(() => root.render(render(false, input, publish)));
  expect(isLive()).toBe(false);

  act(() => root.render(render(true, input, publish)));
  expect(isLive()).toBe(true);

  input.current = null;
  expect(isLive()).toBe(false);
  act(() => root.unmount());
});
