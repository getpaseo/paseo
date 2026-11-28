import { describe, expect, it } from "vitest";
import { createNewRowEstimates } from "./new-row-estimates";

interface Row {
  id: string;
  kind: string;
}

function row(id: string, kind = "assistant_message"): Row {
  return { id, kind };
}

describe("new row estimates", () => {
  it("leaves rows of the first list to the list's averages", () => {
    const estimates = createNewRowEstimates<Row>();
    const first = row("a");

    estimates.noteRows([first]);

    expect(estimates.estimate(first)).toBeUndefined();
  });

  it("estimates a new row at the first measured size of the last new row of its kind", () => {
    const estimates = createNewRowEstimates<Row>();
    estimates.noteRows([row("a")]);
    const second = row("b");
    estimates.noteRows([row("a"), second]);

    expect(estimates.estimate(second)).toBeUndefined();

    estimates.noteMeasured(second, 34);
    estimates.noteMeasured(second, 56);
    const third = row("c");
    estimates.noteRows([row("a"), second, third]);

    expect(estimates.estimate(third)).toBe(34);
  });

  it("keeps sizes per kind", () => {
    const estimates = createNewRowEstimates<Row>();
    estimates.noteRows([]);
    const text = row("a");
    const tool = row("b", "tool_call");
    estimates.noteRows([text, tool]);
    estimates.noteMeasured(text, 34);
    estimates.noteMeasured(tool, 36);
    const nextTool = row("c", "tool_call");
    const nextText = row("d");
    estimates.noteRows([text, tool, nextTool, nextText]);

    expect(estimates.estimate(nextTool)).toBe(36);
    expect(estimates.estimate(nextText)).toBe(34);
  });

  it("records the kind a row has when it is measured", () => {
    const estimates = createNewRowEstimates<Row>();
    estimates.noteRows([]);
    estimates.noteRows([row("a", "thought")]);
    estimates.noteMeasured(row("a", "tool_call"), 36);
    const thought = row("b", "thought");
    const tool = row("c", "tool_call");
    estimates.noteRows([row("a", "tool_call"), thought, tool]);

    expect(estimates.estimate(thought)).toBeUndefined();
    expect(estimates.estimate(tool)).toBe(36);
  });

  it("estimates new rows anywhere in the list", () => {
    const estimates = createNewRowEstimates<Row>();
    estimates.noteRows([row("b"), row("d")]);
    const appendedTool = row("e", "tool_call");
    estimates.noteRows([row("b"), row("d"), appendedTool]);
    estimates.noteMeasured(appendedTool, 36);
    const older = row("a", "tool_call");
    const revealed = row("c", "tool_call");
    estimates.noteRows([older, row("b"), revealed, row("d"), appendedTool]);

    expect(estimates.estimate(older)).toBe(36);
    expect(estimates.estimate(revealed)).toBe(36);
    expect(estimates.estimate(row("b", "tool_call"))).toBeUndefined();
  });

  it("stops estimating a measured row", () => {
    const estimates = createNewRowEstimates<Row>();
    estimates.noteRows([]);
    const first = row("a");
    estimates.noteRows([first]);
    estimates.noteMeasured(first, 34);

    expect(estimates.estimate(first)).toBeUndefined();
  });
});
