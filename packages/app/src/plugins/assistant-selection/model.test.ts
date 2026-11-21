import { describe, expect, it, vi } from "vitest";
import { buildAssistantSelectionMenuItems, dedupeAssistantSelectionActions } from "./model";

describe("dedupeAssistantSelectionActions", () => {
  it("keeps the first action for a title and reports the rest", () => {
    const first = { id: "a", title: "Annotate" };
    const duplicate = { id: "b", title: "Annotate" };
    const other = { id: "c", title: "Explain" };
    const collisions: string[] = [];

    const actions = dedupeAssistantSelectionActions([first, duplicate, other], (action) =>
      collisions.push(action.id),
    );

    expect(actions).toEqual([first, other]);
    expect(collisions).toEqual(["b"]);
  });
});

describe("buildAssistantSelectionMenuItems", () => {
  const action = { title: "Annotate", run: vi.fn(async () => undefined) };
  const base = {
    platform: "ios",
    finished: true,
    messageId: "message-1",
    actions: [action],
    onError: vi.fn(),
  };

  it("offers actions on a finished iOS message and passes the selection", () => {
    const items = buildAssistantSelectionMenuItems(base);

    items?.[0]?.onPress({ text: "selected words" });

    expect(items?.map((item) => item.text)).toEqual(["Annotate"]);
    expect(action.run).toHaveBeenCalledWith({ text: "selected words", messageId: "message-1" });
  });

  it.each([
    ["a streaming message", { finished: false }],
    ["Android", { platform: "android" }],
    ["web", { platform: "web" }],
    ["a message without an id", { messageId: undefined }],
    ["no actions", { actions: [] }],
  ])("offers nothing for %s", (_name, override) => {
    expect(buildAssistantSelectionMenuItems({ ...base, ...override })).toBeUndefined();
  });

  it("reports rejected and thrown action failures", async () => {
    const rejected = new Error("rejected");
    const thrown = new Error("thrown");
    const onError = vi.fn();
    const failing = [
      { title: "Rejects", run: async () => Promise.reject(rejected) },
      {
        title: "Throws",
        run: () => {
          throw thrown;
        },
      },
    ];

    const items = buildAssistantSelectionMenuItems({ ...base, actions: failing, onError });
    items?.forEach((item) => item.onPress({ text: "selected words" }));

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failing[0], rejected));
    expect(onError).toHaveBeenCalledWith(failing[1], thrown);
  });
});
