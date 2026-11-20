import React, { createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptFrameHandle } from "@getpaseo/plugin/client/ui";
import { ScriptFrame } from "./script-frame.web";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(cleanup);

function mount(script: string) {
  const handle = createRef<ScriptFrameHandle>();
  const onMessage = vi.fn();
  const onError = vi.fn();
  render(
    <ScriptFrame
      ref={handle}
      script={script}
      title="A frame"
      onMessage={onMessage}
      onError={onError}
    />,
  );
  return { handle, onMessage, onError };
}

describe("ScriptFrame on the web", () => {
  it("delivers posts made before the page was ready, in order, and hears the replies", async () => {
    const { handle, onMessage } = mount(
      'window.paseoFrame.onMessage = (text) => window.paseoFrame.post("echo:" + text);',
    );
    handle.current?.post("a");
    handle.current?.post("b");
    await waitFor(() => expect(onMessage.mock.calls).toEqual([["echo:a"], ["echo:b"]]));
  });

  it("reports a script that throws", async () => {
    const { onError } = mount('throw new Error("boom");');
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("boom")));
  });

  it("gives the page no storage: localStorage throws in the sandbox", async () => {
    const { onMessage } = mount(
      'try { window.localStorage.getItem("x"); window.paseoFrame.post("storage"); } catch (e) { window.paseoFrame.post("no storage"); }',
    );
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("no storage"));
  });

  it("gives the page no network: the policy refuses a fetch", async () => {
    const { onMessage } = mount(
      'fetch("data:text/plain,x").then(() => window.paseoFrame.post("fetched"), () => window.paseoFrame.post("blocked"));',
    );
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith("blocked"));
  });

  it("ignores a message that did not come from its own frame", async () => {
    const { onMessage } = mount("");
    window.postMessage({ paseoFrame: "message", text: "forged" }, "*");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onMessage).not.toHaveBeenCalled();
  });
});
