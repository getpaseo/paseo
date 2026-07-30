import { describe, expect, it } from "vitest";
import { renderPrompt, renderValue } from "./render.js";

const context = {
  event: { event: "revise", message: "Tighten the proof", data: { branches: ["a", "b"] } },
  inputs: { objective: "Verify behavior" },
  task: { index: 2 },
};

describe("workflow rendering", () => {
  it("preserves native values for exact placeholders and renders inline JSON canonically", () => {
    expect(renderValue("{{ event.data.branches }}", context)).toEqual(["a", "b"]);
    expect(renderValue("branches={{ event.data.branches }}", context)).toBe('branches=["a","b"]');
  });

  it("renders the conditional form used by built-in workflows", () => {
    expect(
      renderPrompt(
        [
          "Review {{ inputs.objective }}.",
          '{% if event.event == "revise" %}',
          "Prior feedback: {{ event.message }}",
          "{% endif %}",
        ].join("\n"),
        context,
      ),
    ).toContain("Prior feedback: Tighten the proof");
  });

  it("fails closed on missing values and unsupported expressions", () => {
    expect(() => renderPrompt("{{ event.data.missing }}", context)).toThrow(
      "undefined workflow value",
    );
    expect(() => renderPrompt("{% for item in inputs %}x{% endfor %}", context)).toThrow(
      "unsupported workflow template tag",
    );
  });
});
