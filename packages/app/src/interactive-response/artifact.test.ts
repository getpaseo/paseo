import { expect, it } from "vitest";
import { artifactProgram, artifactState, artifactMessage, artifactProposal } from "./artifact";

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
  expect(() => artifactState('{"state":{},"proposal":4}')).toThrow();
  expect(artifactMessage({ type: "state", value: '{"state":{},"proposal":"Hi"}' })).toEqual({
    type: "state",
    value: '{"state":{},"proposal":"Hi"}',
  });
  expect(() => artifactMessage({ type: "send", text: "forged" })).toThrow();
  expect(() => artifactMessage({ type: "state", value: "x".repeat(65537) })).toThrow();
});

it("restores historical JSON states but requires envelopes from the live bridge", () => {
  expect(artifactState('{"count":2}')).toEqual({ state: { count: 2 }, proposal: "" });
  expect(() => artifactMessage({ type: "state", value: '{"count":2}' })).toThrow();
});

it("renders catalog content without browser-only host containers", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createLibrary, defineComponent } = await import("@openuidev/react-lang");
  const { z } = await import("zod");
  const { InteractiveRenderer } = await import("./renderer");
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
});

it("uses prepared text while keeping saved JSON and ordinary form values out of the proposal", () => {
  expect(
    artifactProposal({
      note: "Team",
      count: 9,
      invalid: "{",
      artifact: JSON.stringify({ state: { count: 9 }, proposal: "Valider 9" }),
    }),
  ).toBe("Valider 9");
});
