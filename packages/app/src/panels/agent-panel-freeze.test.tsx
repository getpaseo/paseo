// @vitest-environment jsdom
import React, { useCallback, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { createStore, useStore } from "zustand";
import { RetainedPanelActivity, useRetainedPanelActive } from "@/components/retained-panel";
import { AgentPanelFreeze } from "./agent-panel-freeze";

afterEach(cleanup);

test("hidden chats stop rendering while their store advances, then reveal current messages with their draft intact", async () => {
  const store = createStore(() => ({ message: "first" }));
  const renders: string[] = [];
  const activity: boolean[] = [];
  function Chat() {
    const message = useStore(store, (state) => state.message);
    const active = useRetainedPanelActive();
    const [draft, setDraft] = useState("");
    const changeDraft = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
      [],
    );
    renders.push(message);
    useEffect(() => {
      activity.push(active);
    }, [active]);
    return (
      <>
        <output>{message}</output>
        <input aria-label="Draft" value={draft} onChange={changeDraft} />
      </>
    );
  }
  function Panel({ active }: { active: boolean }) {
    return (
      <RetainedPanelActivity active={active}>
        <AgentPanelFreeze>
          <Chat />
        </AgentPanelFreeze>
      </RetainedPanelActivity>
    );
  }
  const view = render(<Panel active />);
  const input = view.getByRole("textbox");
  fireEvent.change(input, { target: { value: "unfinished message" } });
  await act(async () => {
    view.rerender(<Panel active={false} />);
  });
  expect(activity).toEqual([true, false]);
  const hiddenRenderCount = renders.length;
  for (let index = 0; index < 5; index++) {
    await act(async () => {
      store.setState({ message: `message ${index}` });
    });
  }
  expect(store.getState().message).toBe("message 4");
  expect(renders).toHaveLength(hiddenRenderCount);
  await act(async () => {
    view.rerender(<Panel active />);
  });
  expect(view.getByRole("status").textContent).toBe("message 4");
  expect(view.getByRole("textbox")).toBe(input);
  expect((input as HTMLInputElement).value).toBe("unfinished message");
  expect(activity).toEqual([true, false, true]);
});
