import { describe, expect, it } from "vitest";
import { validateInteractiveSource, validateInteractiveState } from "./interactive-response.js";

describe("interactive responses", () => {
  it("validates the shared catalog and selected values", () => {
    const source = 'root = Layout([Text("Choose"), Selection("choice", "Plan", ["Basic", "Pro"])])';
    expect(validateInteractiveSource(source).typeName).toBe("Layout");
    expect(validateInteractiveState(source, { choice: "Pro" })).toEqual({ choice: "Pro" });
    expect(() => validateInteractiveState(source, { choice: "Other" })).toThrow();
    expect(() =>
      validateInteractiveState('root = Layout([Selection("choice", "Plan", ["true", "1"])])', {
        choice: true,
      }),
    ).toThrow();
    expect(() => validateInteractiveState(source, { other: "Pro" })).toThrow();
  });
  it("rejects incomplete, unknown, dynamic and oversized sources", () => {
    for (const source of [
      "root = Text(",
      'root = Unknown("x")',
      "root = Text($x)",
      'root = Layout([Query("fetch")])',
      "x".repeat(131073),
    ]) {
      expect(() => validateInteractiveSource(source)).toThrow();
    }
  });
});

it("extracts durable references from native and MCP results", async () => {
  const { extractInteractiveDocumentId } = await import("./interactive-response-reference.js");
  const result = { structuredContent: { documentId: "durable-id" }, content: [] };
  expect(extractInteractiveDocumentId(result)).toBe("durable-id");
  expect(
    extractInteractiveDocumentId(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ documentId: "durable-id" }) }],
      }),
    ),
  ).toBe("durable-id");
  expect(extractInteractiveDocumentId("not-json")).toBeNull();
});
it("reads content-block arrays emitted by provider tool adapters", async () => {
  const { extractInteractiveDocumentId } = await import("./interactive-response-reference.js");
  const blocks = [{ type: "text", text: JSON.stringify({ documentId: "native-id" }) }];
  expect(extractInteractiveDocumentId(blocks)).toBe("native-id");
  expect(extractInteractiveDocumentId({ structuredContent: null, content: blocks })).toBe(
    "native-id",
  );
  expect(
    extractInteractiveDocumentId({ content: JSON.stringify({ documentId: "native-id" }) }),
  ).toBe("native-id");
});

it("keeps independent custom visual states without breaking unnamed historical documents", () => {
  const source =
    'root = Layout([HtmlArtifact("<p>A</p>", "first"), HtmlArtifact("<p>B</p>", "second")])';
  const state = {
    first: JSON.stringify({ state: { count: 2 }, proposal: "A" }),
    second: JSON.stringify({ state: { count: 3 }, proposal: "B" }),
  };
  expect(validateInteractiveState(source, state)).toEqual(state);
  expect(
    validateInteractiveState('root = Layout([HtmlArtifact("<p>Old</p>")])', {
      artifact: '{"count":1}',
    }),
  ).toEqual({ artifact: '{"count":1}' });
  expect(() => validateInteractiveState(source, { third: "{}" })).toThrow();
  expect(() =>
    validateInteractiveSource(
      'root = Layout([HtmlArtifact("<p>A</p>","same"), Input("same","Note")])',
    ),
  ).toThrow();
});
