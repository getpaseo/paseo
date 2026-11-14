import { describe, expect, it } from "vitest";
import {
  cacheMermaidRender,
  cacheMermaidRenderReply,
  createMermaidRenderModel,
  getMermaidRenderRequest,
  getMermaidStyleKey,
  readCachedMermaidRender,
  reduceMermaidRenderModel,
  resolveMermaidRenderInput,
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

  it("only reuses cached dimensions for the same palette and requests a new revision on palette change", () => {
    const source = "flowchart LR\nUniqueCacheTest --> Done";
    const palette = { colors: { primaryColor: "#123456" } };
    const otherPalette = { colors: { primaryColor: "#abcdef" } };

    const firstInput = resolveMermaidRenderInput({
      source,
      phase: "complete",
      colorScheme: "light",
      options: palette,
    });
    const first = createMermaidRenderModel(firstInput);
    expect(first.visible).toBeNull();

    cacheMermaidRender(
      { source, colorScheme: "light", height: 120, width: 180 },
      getMermaidStyleKey(palette),
    );
    const rendered = reduceMermaidRenderModel(first, {
      type: "rendered",
      revision: first.revision,
      source,
      colorScheme: "light",
      dimensions: { height: 120, width: 180 },
    });

    const same = createMermaidRenderModel(
      resolveMermaidRenderInput({
        source,
        phase: "complete",
        colorScheme: "light",
        options: palette,
      }),
    );
    expect(same.visible?.width).toBe(180);

    const differentInput = resolveMermaidRenderInput({
      source,
      phase: "complete",
      colorScheme: "light",
      options: otherPalette,
    });
    const different = createMermaidRenderModel(differentInput);
    expect(different.visible).toBeNull();

    const updatedInPlace = reduceMermaidRenderModel(rendered, {
      type: "inputChanged",
      input: differentInput,
    });
    expect(updatedInPlace.status).toBe("pending");
    expect(updatedInPlace.revision).toBe(rendered.revision + 1);
    expect(updatedInPlace.visible?.width).toBe(180);
    expect(getMermaidRenderRequest(updatedInPlace)).toEqual({
      revision: rendered.revision + 1,
      source,
      colorScheme: "light",
    });
  });

  it("does not reuse cached dimensions for a different default shape", () => {
    const source = "flowchart LR\nShapeCache --> Done";
    const rounded = {
      colors: { primaryColor: "#123456" },
      defaultShape: "rounded" as const,
    };
    const diamond = {
      colors: { primaryColor: "#123456" },
      defaultShape: "diamond" as const,
    };

    cacheMermaidRender(
      { source, colorScheme: "light", height: 90, width: 200 },
      getMermaidStyleKey(rounded),
    );

    const diamondModel = createMermaidRenderModel(
      resolveMermaidRenderInput({
        source,
        phase: "complete",
        colorScheme: "light",
        options: diamond,
      }),
    );
    expect(diamondModel.visible).toBeNull();

    const again = createMermaidRenderModel(
      resolveMermaidRenderInput({
        source,
        phase: "complete",
        colorScheme: "light",
        options: rounded,
      }),
    );
    expect(again.visible?.width).toBe(200);
  });

  it("rejects an invalid runtime style before it becomes a request", () => {
    const invalid = resolveMermaidRenderInput({
      source: "flowchart LR\nA --> B",
      phase: "complete",
      colorScheme: "dark",
      options: { fontSize: 14.5 },
    });
    const rejected = createMermaidRenderModel(invalid);
    expect(rejected.status).toBe("rejected");
    expect(getMermaidRenderRequest(rejected)).toBeNull();

    const valid = resolveMermaidRenderInput({
      source: "flowchart LR\nA --> B",
      phase: "complete",
      colorScheme: "dark",
      options: { fontSize: 14 },
    });
    expect(valid.rejected).toBe(false);
    expect(getMermaidRenderRequest(createMermaidRenderModel(valid))).not.toBeNull();
  });

  it("only caches a render result whose style still matches the request", () => {
    const source = "flowchart LR\nStaleStyleCache --> Done";
    const rounded = { defaultShape: "rounded" as const };
    const diamond = { defaultShape: "diamond" as const };
    const roundedModel = createMermaidRenderModel(
      resolveMermaidRenderInput({
        source,
        phase: "complete",
        colorScheme: "light",
        options: rounded,
      }),
    );
    const diamondModel = reduceMermaidRenderModel(roundedModel, {
      type: "inputChanged",
      input: resolveMermaidRenderInput({
        source,
        phase: "complete",
        colorScheme: "light",
        options: diamond,
      }),
    });

    cacheMermaidRenderReply(
      diamondModel,
      { source, colorScheme: "light", height: 40, width: 60 },
      roundedModel.revision,
    );
    expect(readCachedMermaidRender(source, "light", getMermaidStyleKey(diamond))).toBeNull();
    expect(readCachedMermaidRender(source, "light", getMermaidStyleKey(rounded))).toBeNull();

    cacheMermaidRenderReply(
      diamondModel,
      { source, colorScheme: "light", height: 90, width: 200 },
      diamondModel.revision,
    );
    expect(readCachedMermaidRender(source, "light", getMermaidStyleKey(diamond))).toEqual({
      source,
      colorScheme: "light",
      height: 90,
      width: 200,
    });
  });
});
