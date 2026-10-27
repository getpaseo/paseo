/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import React, { createElement, useMemo } from "react";
import { artifactProgram, artifactState, artifactMessage, artifactProposal } from "./artifact";
import { InteractiveFields } from "./fields";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { useArtifact, type ArtifactCommand } from "./use-artifact";

vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

it("extracts inline programs without exposing scripts or network attributes to the renderer", () => {
  const program = artifactProgram(
    '<div id="count">0</div><script>paseo.render("ok")</script><script src="https://evil"></script><input id="n" min="1" max="10" step="1" oninput="evil()">',
  );
  expect(program.scripts).toEqual(['paseo.render("ok")']);
  expect(program.markup).not.toContain("<script");
  expect(program.markup).not.toContain("evil");
  expect(program.markup).toContain('min="1"');
});

it("validates restored state and proposed messages without accepting malformed envelopes", () => {
  expect(artifactState(undefined)).toEqual({ state: null, proposal: "" });
  expect(artifactState('{"state":{"count":2},"proposal":"Choose 2"}')).toEqual({
    state: { count: 2 },
    proposal: "Choose 2",
  });
  expect(artifactState('{"state":{},"proposal":4}')).toEqual({
    state: { state: {}, proposal: 4 },
    proposal: "",
  });
  expect(() => artifactMessage({ type: "state", value: '{"state":{},"proposal":4}' })).toThrow();
  expect(artifactMessage({ type: "state", value: '{"state":{},"proposal":"Hi"}' })).toEqual({
    type: "state",
    value: '{"state":{},"proposal":"Hi"}',
  });
  expect(() => artifactMessage({ type: "send", text: "forged" })).toThrow();
  expect(() => artifactMessage({ type: "state", value: "x".repeat(65537) })).toThrow();
});

it("restores historical JSON states but requires envelopes from the live bridge", () => {
  expect(artifactState('{"count":2}')).toEqual({ state: { count: 2 }, proposal: "" });
  expect(artifactState('{"count":2,"proposal":"draft"}')).toEqual({
    state: { count: 2, proposal: "draft" },
    proposal: "",
  });
  expect(() => artifactMessage({ type: "state", value: '{"count":2}' })).toThrow();
});

it("renders catalog content without browser-only host containers", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createLibrary, defineComponent } = await import("@openuidev/react-lang");
  const { z } = await import("zod");
  const { InteractiveRenderer, getArtifactNames } = await import("./renderer");
  const library = createLibrary({
    root: "Text",
    components: [
      defineComponent({
        name: "Text",
        description: "Text",
        props: z.object({ content: z.string() }),
        component: ({ props }) => createElement("span", null, props.content),
      }),
    ],
  });
  const markup = renderToStaticMarkup(
    createElement(InteractiveRenderer, { source: 'root = Text("Native content")', library }),
  );
  expect(markup).toBe("<span>Native content</span>");
  expect(
    getArtifactNames('root = Layout([Input("notes","Note"), HtmlArtifact("<p>A</p>","visual")])'),
  ).toEqual(["visual"]);
});

it.each([false, true])(
  "preserves in-flight input before hiding a panel (quick resume: %s)",
  async (quickResume) => {
    let active = true;
    const state: Record<string, string> = {};
    const commands: ArtifactCommand[] = [];
    let registeredFlush = () => Promise.resolve();
    const fields = {
      state,
      disabled: false,
      change: (name: string, value: string | number) => {
        state[name] = String(value);
      },
      registerRuntime: (flush: () => Promise<void>) => {
        registeredFlush = flush;
        return () => {};
      },
    };
    const { result, rerender, unmount } = renderHook(
      () =>
        useArtifact({
          html: "<p>Visual</p>",
          name: "visual",
          colorScheme: "light",
          post: (command) => commands.push(command),
        }),
      {
        wrapper: function Wrapper({ children }) {
          const value = useMemo(() => fields, []);
          return (
            <RetainedPanelActivity active={active}>
              <InteractiveFields.Provider value={value}>{children}</InteractiveFields.Provider>
            </RetainedPanelActivity>
          );
        },
      },
    );
    try {
      const session = commands.at(-1)!.session;
      act(() => result.current.receive({ session, message: { type: "ready" } }));
      active = false;
      rerender();
      expect(result.current.mounted).toBe(true);
      const flush = commands.findLast((command) => command.command.type === "flush")!;
      expect(flush.command.type).toBe("flush");
      if (quickResume) {
        active = true;
        rerender();
      }
      const first = registeredFlush();
      expect(registeredFlush()).toBe(first);
      const value = '{"state":{"count":9},"proposal":"Choose 9"}';
      await act(async () => {
        result.current.receive({ session, message: { type: "state", value } });
        result.current.receive({
          session,
          message: { type: "flushed", id: (flush.command as { id: number }).id },
        });
        await first;
      });
      expect(state).toEqual({ visual: value });
      expect(result.current.mounted).toBe(quickResume);
      active = true;
      rerender();
      expect(result.current.mounted).toBe(true);
      expect(result.current.revision).toBe(1);
      const config = new DOMParser()
        .parseFromString(result.current.source, "text/html")
        .getElementById("config")!;
      expect(JSON.parse(config.textContent!).initial).toBe(value);
    } finally {
      unmount();
    }
  },
);

it("uses prepared text while keeping saved JSON and ordinary form values out of the proposal", () => {
  expect(
    artifactProposal(
      {
        note: "Team",
        count: 9,
        invalid: "{",
        artifact: JSON.stringify({ state: { count: 9 }, proposal: "Valider 9" }),
      },
      ["artifact"],
    ),
  ).toBe("Valider 9");
  expect(artifactProposal({ notes: '{"state":null,"proposal":"Ordinary note"}' }, [])).toBe("");
});

it("closes an expanded visual after a failed flush, retains the latest state and still blocks sending", async () => {
  const { render, fireEvent, waitFor } = await import("@testing-library/react");
  let fields!: React.ContextType<typeof InteractiveFields>;
  let rejectFlush = false;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const flushFirst = () =>
    rejectFlush ? Promise.reject(new Error("Visual failed")) : Promise.resolve();
  const flushSecond = () => (rejectFlush ? waiting : Promise.resolve());
  const save = vi.fn(async () => ({ document: { revision: 1 } }));
  const send = vi.fn(async () => "sent");
  const document = {
    id: "visual-document",
    title: "Visual",
    summary: "Choose",
    revision: 0,
    source: 'root = HtmlArtifact("<p>Visual</p>","visual")',
    state: {},
  };
  vi.doMock("@/data/query", () => ({
    useFetchQuery: () => ({ data: document, dataUpdatedAt: 1, refetch: vi.fn() }),
  }));
  vi.doMock("@/tool-calls/detail-level/grouping", () => ({
    describeToolCall: () => ({ status: "completed" }),
  }));
  vi.doMock("./tool-result", () => ({ interactiveToolDocumentId: () => document.id }));
  vi.doMock("./context", () => ({
    useInteractiveConversation: () => ({
      client: { updateInteractiveResponse: save },
      serverId: "server",
      agentId: "agent",
      supported: true,
      readOnly: false,
    }),
  }));
  vi.doMock("./send", () => ({ sendConversationAction: send }));
  vi.doMock("./library", () => ({ library: {} }));
  vi.doMock("@/components/ui/button", () => ({
    Button: ({ onPress, children }: { onPress: () => void; children: React.ReactNode }) =>
      createElement("button", { type: "button", onClick: onPress }, children),
  }));
  vi.doMock("@/components/adaptive-modal-sheet", () => ({
    AdaptiveModalSheet: ({
      visible,
      onClose,
      children,
    }: {
      visible: boolean;
      onClose: () => void;
      children: React.ReactNode;
    }) =>
      visible
        ? createElement(
            "section",
            { "aria-label": "Expanded" },
            createElement("button", { type: "button", onClick: onClose }, "Close"),
            children,
          )
        : null,
  }));
  vi.doMock("./renderer", async (original) => {
    const actual = await original<typeof import("./renderer")>();
    return {
      ...actual,
      InteractiveRenderer: function RuntimeFixture() {
        const current = React.useContext(InteractiveFields);
        const { registerRuntime } = current;
        fields = current;
        React.useEffect(() => {
          const first = registerRuntime(flushFirst);
          const second = registerRuntime(flushSecond);
          return () => {
            first();
            second();
          };
        }, [registerRuntime]);
        return createElement("output", null, String(current.state.visual ?? ""));
      },
    };
  });
  const { InteractiveResponseCard } = await import("./card");
  vi.stubGlobal("React", React);
  const view = render(
    createElement(InteractiveResponseCard, {
      item: {} as React.ComponentProps<typeof InteractiveResponseCard>["item"],
    }),
  );
  try {
    fireEvent.click(view.getByText("interactive.expand"));
    await waitFor(() => expect(view.getByRole("region", { name: "Expanded" })).toBeTruthy());
    rejectFlush = true;
    fireEvent.click(view.getByText("interactive.send"));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Visual failed"));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(view.getByText("Close"));
    // Another visual still has a final state in transit when the first one rejects.
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.queryByRole("region", { name: "Expanded" })).not.toBeNull();
    const latest = '{"state":{"count":12},"proposal":"Choose 12"}';
    await act(async () => {
      fields.change("visual", latest);
      release();
      await waiting;
    });
    await waitFor(() => expect(view.queryByRole("region", { name: "Expanded" })).toBeNull());
    expect(view.getByRole("status").textContent).toBe(latest);
    expect(view.getByRole("alert").textContent).toBe("Visual failed");
    expect(save).toHaveBeenLastCalledWith("agent", document.id, 0, { visual: latest });
    fireEvent.click(view.getByText("interactive.send"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(send).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toBe(latest);
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
    for (const name of [
      "@/data/query",
      "@/tool-calls/detail-level/grouping",
      "./tool-result",
      "./context",
      "./send",
      "./library",
      "@/components/ui/button",
      "@/components/adaptive-modal-sheet",
      "./renderer",
    ])
      vi.doUnmock(name);
  }
});
