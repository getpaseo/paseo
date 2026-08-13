import { describe, expect, it } from "vitest";
import {
  createMermaidRenderModel,
  getMermaidRenderRequest,
  reduceMermaidRenderModel,
  type MermaidRenderInput,
  type MermaidRenderModel,
} from "./render-model";

function input(overrides: Partial<MermaidRenderInput> = {}): MermaidRenderInput {
  return {
    source: "flowchart TD\nA --> B",
    phase: "streaming",
    colorScheme: "dark",
    rejected: false,
    cached: null,
    ...overrides,
  };
}

function renderCurrent(state: MermaidRenderModel): MermaidRenderModel {
  return reduceMermaidRenderModel(state, {
    type: "rendered",
    revision: state.revision,
    source: state.source,
    colorScheme: state.colorScheme,
    dimensions: { height: 120, width: 240 },
  });
}

describe("Mermaid render model", () => {
  it("shows each valid streamed revision", () => {
    const first = renderCurrent(createMermaidRenderModel(input()));
    const secondPending = reduceMermaidRenderModel(first, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --> B\nB --> C" }),
    });
    const second = renderCurrent(secondPending);

    expect(first.visible?.source).toBe("flowchart TD\nA --> B");
    expect(second.visible?.source).toBe("flowchart TD\nA --> B\nB --> C");
  });

  it("keeps the last valid preview across a transient streaming failure", () => {
    const rendered = renderCurrent(createMermaidRenderModel(input()));
    const pending = reduceMermaidRenderModel(rendered, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --" }),
    });
    const failed = reduceMermaidRenderModel(pending, {
      type: "renderFailed",
      revision: pending.revision,
    });

    expect(failed.status).toBe("failed");
    expect(failed.visible?.source).toBe("flowchart TD\nA --> B");
  });

  it("clears a stale preview when failed source becomes final", () => {
    const rendered = renderCurrent(createMermaidRenderModel(input()));
    const pending = reduceMermaidRenderModel(rendered, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --" }),
    });
    const failed = reduceMermaidRenderModel(pending, {
      type: "renderFailed",
      revision: pending.revision,
    });
    const complete = reduceMermaidRenderModel(failed, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --", phase: "complete" }),
    });

    expect(complete.status).toBe("failed");
    expect(complete.visible).toBeNull();
  });

  it("uses the completion phase when an in-flight final render fails", () => {
    const rendered = renderCurrent(createMermaidRenderModel(input()));
    const pending = reduceMermaidRenderModel(rendered, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --" }),
    });
    const completePending = reduceMermaidRenderModel(pending, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --", phase: "complete" }),
    });
    const failed = reduceMermaidRenderModel(completePending, {
      type: "renderFailed",
      revision: completePending.revision,
    });

    expect(failed.visible).toBeNull();
  });

  it("ignores obsolete render results", () => {
    const initial = createMermaidRenderModel(input());
    const newer = reduceMermaidRenderModel(initial, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --> C" }),
    });
    const obsolete = reduceMermaidRenderModel(newer, {
      type: "rendered",
      revision: initial.revision,
      source: initial.source,
      colorScheme: initial.colorScheme,
      dimensions: { height: 90, width: 180 },
    });

    expect(obsolete).toBe(newer);
    expect(getMermaidRenderRequest(obsolete)).toEqual({
      revision: newer.revision,
      source: "flowchart TD\nA --> C",
      colorScheme: "dark",
    });
  });

  it("uses an obsolete successful prefix as the first streaming preview", () => {
    const initial = createMermaidRenderModel(input());
    const newer = reduceMermaidRenderModel(initial, {
      type: "inputChanged",
      input: input({ source: "flowchart TD\nA --> B\nB --" }),
    });
    const preview = reduceMermaidRenderModel(newer, {
      type: "rendered",
      revision: initial.revision,
      source: initial.source,
      colorScheme: initial.colorScheme,
      dimensions: { height: 90, width: 180 },
    });

    expect(preview.status).toBe("pending");
    expect(preview.visible?.source).toBe(initial.source);
    expect(getMermaidRenderRequest(preview)?.source).toBe("flowchart TD\nA --> B\nB --");
  });

  it("keeps the last preview when source policy rejects a streaming revision", () => {
    const rendered = renderCurrent(createMermaidRenderModel(input()));
    const rejected = reduceMermaidRenderModel(rendered, {
      type: "inputChanged",
      input: input({ source: 'flowchart TD\nA@{ img: "https://example.com/x" }', rejected: true }),
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.visible).toBe(rendered.visible);
    expect(getMermaidRenderRequest(rejected)).toBeNull();
  });

  it("clears the last preview when the rejected revision is complete", () => {
    const rendered = renderCurrent(createMermaidRenderModel(input()));
    const rejected = reduceMermaidRenderModel(rendered, {
      type: "inputChanged",
      input: input({
        source: 'flowchart TD\nA@{ img: "https://example.com/x" }',
        phase: "complete",
        rejected: true,
      }),
    });

    expect(rejected.status).toBe("rejected");
    expect(rejected.visible).toBeNull();
  });
});
