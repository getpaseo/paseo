import { describe, expect, test } from "vitest";

import { OmpHarness } from "./test-utils/omp-harness.js";

function startAsk(omp: OmpHarness, multi: boolean): void {
  omp.emit({
    type: "tool_execution_start",
    toolCallId: "ask-1",
    toolName: "ask",
    args: {
      questions: [
        {
          id: "colors",
          question: "Which colors?",
          multi,
          options: [
            { label: "Red", description: "Warm" },
            { label: "Blue", description: "Cool" },
          ],
        },
      ],
    },
  });
}

function select(omp: OmpHarness, id: string, title: string, options: string[]): void {
  omp.emit({ type: "extension_ui_request", id, method: "select", title, options });
}

describe("OMP ask RPC UI", () => {
  test("recognizes ask arguments from the assistant message before the UI request", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "ask-1",
            name: "ask",
            arguments: {
              questions: [
                {
                  id: "colors",
                  question: "Which colors?",
                  multi: true,
                  options: [
                    { label: "Red", description: "Warm" },
                    { label: "Blue", description: "Cool" },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({
      multiSelect: true,
      allowOther: true,
    });
    startAsk(omp, true);
  });
  test("answers the multi-select loop from one Paseo question", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);

    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]).toMatchObject({
      kind: "question",
      input: {
        questions: [
          {
            question: "Which colors?",
            multiSelect: true,
            allowOther: true,
            options: [{ label: "Red" }, { label: "Blue" }],
          },
        ],
      },
    });
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Blue, Red" } },
    });
    select(omp, "select-2", "(1 selected) Which colors?", [
      "Red",
      "Blue",
      "✓ Done selecting",
      "Other (type your own)",
    ]);
    select(omp, "select-3", "(2 selected) Which colors?", [
      "Red",
      "Blue",
      "✔ Done selecting",
      "Other (type your own)",
    ]);

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Blue" } },
      { id: "select-2", response: { value: "Red" } },
      { id: "select-3", response: { value: "✔ Done selecting" } },
    ]);
  });

  test("passes a single-select Other answer through OMP's editor", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, false);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({ allowOther: true });
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Violet" } },
    });
    omp.emit({
      type: "extension_ui_request",
      id: "editor-1",
      method: "editor",
      title: "Which colors? ○ Red ○ Blue ◉ Other (type your own) Enter your response:",
    });

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Other (type your own)" } },
      { id: "editor-1", response: { value: "Violet" } },
    ]);
  });

  test("passes multi-select choices and Other through the same editor flow", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Red, Violet" } },
    });
    select(omp, "select-2", "(1 selected) Which colors?", [
      "Red",
      "Blue",
      "✓ Done selecting",
      "Other (type your own)",
    ]);
    omp.emit({
      type: "extension_ui_request",
      id: "editor-1",
      method: "editor",
      title: "(1 selected) Which colors?",
    });

    expect(omp.pendingPermissions()).toHaveLength(0);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Red" } },
      { id: "select-2", response: { value: "Other (type your own)" } },
      { id: "editor-1", response: { value: "Violet" } },
    ]);
  });

  test("cancels an ask without leaving replay state behind", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", { behavior: "deny" });
    select(omp, "select-after-cancel", "Another question", ["One", "Two"]);

    expect(omp.extensionUiResponses()).toEqual([{ id: "select-1", response: { cancelled: true } }]);
    expect(omp.pendingPermissions()).toHaveLength(1);
    expect(omp.pendingPermissions()[0]?.id).toBe("select-after-cancel");
  });

  test("keeps single choices, tool approvals, and free-form input independent", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, false);
    select(omp, "select-1", "Which colors?", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Blue" } },
    });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "select-1",
      response: { value: "Blue" },
    });

    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask",
      result: "Blue",
      isError: false,
    });
    omp.requestToolApproval({ id: "approval", tool: "bash", detail: "echo hi" });
    expect(omp.pendingPermissions()[0]).toMatchObject({ id: "approval", kind: "tool" });
    await omp.respondToPermission("approval", { behavior: "allow" });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "approval",
      response: { value: "Approve" },
    });

    omp.emit({ type: "extension_ui_request", id: "input", method: "input", title: "Type a value" });
    expect(omp.pendingPermissions()[0]).toMatchObject({ id: "input", kind: "question" });
    await omp.respondToPermission("input", {
      behavior: "allow",
      updatedInput: { answers: { Response: "typed value" } },
    });
    expect(omp.extensionUiResponses()).toContainEqual({
      id: "input",
      response: { value: "typed value" },
    });
  });

  test("recognizes OMP's numbered question title", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors? (1/2)", ["Red", "Blue", "Other (type your own)"]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]).toMatchObject({ multiSelect: true });
  });

  test("keeps descriptions with their labels when a select event reorders rows", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, true);
    select(omp, "select-1", "Which colors?", ["Blue", "Red", "Other (type your own)"]);

    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toEqual([
      { label: "Blue", description: "Cool" },
      { label: "Red", description: "Warm" },
    ]);
  });

  test("keeps a recommended option's description with its display label", async () => {
    const omp = new OmpHarness();
    await omp.start();
    startAsk(omp, false);
    select(omp, "select-1", "Which colors?", [
      "Red (Recommended)",
      "Blue",
      "Other (type your own)",
    ]);
    expect(omp.pendingPermissions()[0]?.input?.questions?.[0]?.options).toEqual([
      { label: "Red (Recommended)", description: "Warm" },
      { label: "Blue", description: "Cool" },
    ]);
  });

  test("cancels cleanly when OMP omits Done selecting in a multi-question ask", async () => {
    const omp = new OmpHarness();
    await omp.start();
    omp.emit({
      type: "tool_execution_start",
      toolCallId: "ask-1",
      toolName: "ask",
      args: {
        questions: [
          {
            id: "colors",
            question: "Which colors?",
            multi: true,
            options: [{ label: "Red" }, { label: "Blue" }],
          },
          {
            id: "shape",
            question: "Which shape?",
            options: [{ label: "Round" }, { label: "Square" }],
          },
        ],
      },
    });
    select(omp, "select-1", "Which colors? (1/2)", ["Red", "Blue", "Other (type your own)"]);
    await omp.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Red" } },
    });
    // OMP's RPC select omits the right-arrow navigation callback and, with
    // allowForward true, also omits its Done row on every follow-up request.
    select(omp, "select-2", "(1 selected) Which colors? (1/2)", [
      "Red",
      "Blue",
      "Other (type your own)",
    ]);

    expect(omp.extensionUiResponses()).toEqual([
      { id: "select-1", response: { value: "Red" } },
      { id: "select-2", response: { cancelled: true } },
    ]);
    expect(omp.pendingPermissions()).toHaveLength(0);
    omp.emit({
      type: "tool_execution_end",
      toolCallId: "ask-1",
      toolName: "ask",
      result: "Ask tool was cancelled by the user",
      isError: true,
    });
    expect(omp.timeline()).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        name: "ask",
        status: "failed",
      }),
    );
  });
});

function form(omp: OmpHarness, id: string, html: string | undefined): void {
  omp.emit({
    type: "extension_ui_request",
    id,
    method: "form",
    ...(html === undefined ? {} : { html }),
  });
}

function questions(omp: OmpHarness): unknown {
  return omp.pendingPermissions()[0]?.input?.questions;
}

describe("OMP 19.1 HTML form ask", () => {
  // Captured from `omp --mode rpc-ui --no-session` 19.1.0 and 19.2.1 (issue #10471).
  const YES_NO =
    '<form><label><input type="radio" name="ok" value="yes" checked> Yes</label><label><input type="radio" name="ok" value="no"> No</label></form>';
  const COLOR =
    '<form><fieldset><legend>Which color do you prefer?</legend><label><input type="radio" name="color" value="Red" checked> Red</label><label><input type="radio" name="color" value="Blue"> Blue</label></fieldset></form>';

  test("shows a radio form as a question card and returns the chosen value", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", YES_NO);

    expect(omp.pendingPermissions()).toMatchObject([
      { id: "form-1", kind: "question", metadata: { extensionUiMethod: "form" } },
    ]);
    expect(questions(omp)).toEqual([
      {
        question: "ok",
        header: "ok",
        options: [{ label: "Yes", description: "Default" }, { label: "No" }],
        multiSelect: false,
        allowOther: true,
        allowEmpty: true,
      },
    ]);
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { ok: "No" } },
    });
    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { ok: "no" } } },
    ]);
  });

  test("submits the preselected default when the question is left unanswered", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", COLOR);

    expect(questions(omp)).toMatchObject([
      { question: "Which color do you prefer?", header: "color" },
    ]);
    await omp.respondToPermission("form-1", { behavior: "allow", updatedInput: { answers: {} } });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { color: "Red" } } },
    ]);
  });

  test("passes a typed Other answer as the radio value", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", COLOR);
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { color: "Green" } },
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { color: "Green" } } },
    ]);
  });

  test("maps a multi-control form to one question per named control", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(
      omp,
      "form-1",
      `<form>
        <h2>Setup</h2>
        <p>Pick a store and the tools to install.</p>
        <label><input type="radio" name="store" value="sqlite" checked>SQLite</label>
        <label><input type="radio" name="store" value="pg">Postgres</label>
        <label><input type="radio" name="store" value="other">Other (describe)</label>
        <p>Which tools?</p>
        <label><input type="checkbox" name="tools" value="x,y">X, Y</label>
        <label><input type="checkbox" name="tools" value="z" checked>Z</label>
        <label><input type="checkbox" name="tools" value="w" disabled>W</label>
        <label>Days <input type="number" name="days" min="1"></label>
        <label for="note">Note</label><textarea id="note" name="note" placeholder="Anything else?">keep logs</textarea>
        <label>Region <select name="region"><option value="eu">Europe</option><option value="us" selected>US</option><option value="ap" disabled>Asia</option></select></label>
        <label><input type="checkbox" name="agree" value="yes"> I accept the terms</label>
        <input type="hidden" name="token" value="abc">
        <input type="text" placeholder="unnamed">
        <input type="file" name="upload">
        <button type="submit">Send</button>
      </form>`,
    );

    expect(questions(omp)).toEqual([
      {
        question: "Setup\n\nPick a store and the tools to install.",
        header: "store",
        options: [
          { label: "SQLite", description: "Default" },
          { label: "Postgres" },
          { label: "Other (describe)" },
        ],
        multiSelect: false,
        allowOther: false,
        allowEmpty: true,
      },
      {
        question: "Which tools?",
        header: "tools",
        options: [{ label: "X,Y" }, { label: "Z", description: "Default" }],
        multiSelect: true,
        allowOther: true,
        allowEmpty: true,
      },
      {
        question: "Days",
        header: "days",
        options: [],
        multiSelect: false,
        allowOther: false,
        allowEmpty: true,
      },
      {
        question: "Note",
        header: "note",
        options: [{ label: "keep logs", description: "Default" }],
        multiSelect: false,
        allowOther: true,
        allowEmpty: true,
        placeholder: "Anything else?",
      },
      {
        question: "Region",
        header: "region",
        options: [{ label: "Europe" }, { label: "US", description: "Default" }],
        multiSelect: false,
        allowOther: false,
        allowEmpty: true,
      },
      {
        question: "I accept the terms",
        header: "agree",
        options: [{ label: "Yes" }, { label: "No" }],
        multiSelect: false,
        allowOther: false,
        allowEmpty: false,
      },
    ]);

    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: {
        answers: {
          store: "Postgres",
          tools: "X,Y, Z, hammer",
          days: "7",
          note: "",
          region: "Europe",
          agree: "No",
        },
      },
    });
    expect(omp.extensionUiResponses()).toEqual([
      {
        id: "form-1",
        response: {
          data: {
            store: "pg",
            tools: ["x,y", "z", "hammer"],
            days: "7",
            note: "keep logs",
            region: "eu",
          },
        },
      },
    ]);
  });

  test("returns cancelled when the user dismisses the form", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", YES_NO);
    await omp.respondToPermission("form-1", { behavior: "deny" });
    expect(omp.extensionUiResponses()).toEqual([{ id: "form-1", response: { cancelled: true } }]);
  });

  test("closes the card without a reply when OMP cancels the form", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", YES_NO);
    omp.emit({
      type: "extension_ui_request",
      id: "cancel-1",
      method: "cancel",
      targetId: "form-1",
    });

    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.eventTypes()).toContain("permission_resolved");
    await expect(omp.respondToPermission("form-1", { behavior: "deny" })).rejects.toThrow();
    expect(omp.extensionUiResponses()).toEqual([]);
  });

  test("keeps Dismiss a cancel when a text field is prefilled", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", '<form><label>Branch <input name="branch" value="main"></label></form>');

    // The card submits on Dismiss only when every question is optional free text;
    // the prefilled value is an option, so Dismiss stays a cancel.
    expect(questions(omp)).toEqual([
      {
        question: "Branch",
        header: "branch",
        options: [{ label: "main", description: "Default" }],
        multiSelect: false,
        allowOther: true,
        allowEmpty: true,
      },
    ]);
    await omp.respondToPermission("form-1", { behavior: "allow", updatedInput: { answers: {} } });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { branch: "main" } } },
    ]);
  });

  test("lets optional text fields stay blank and names Dismiss Skip when that submits", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(
      omp,
      "form-1",
      '<form><label>Why? <input name="why"></label><label>Notes <textarea name="notes"></textarea></label></form>',
    );

    expect(questions(omp)).toMatchObject([
      { header: "why", options: [], allowEmpty: true, dismissLabel: "Skip" },
      { header: "notes", options: [], allowEmpty: true, dismissLabel: "Skip" },
    ]);
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { why: "", notes: "" } },
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { why: "", notes: "" } } },
    ]);
  });

  test("requires an answer for a required text field", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(
      omp,
      "form-1",
      '<form><label>Name <input name="name" required></label><label>Why? <input name="why"></label></form>',
    );

    expect(questions(omp)).toMatchObject([
      { header: "name", allowEmpty: false },
      { header: "why", allowEmpty: true },
    ]);
    expect(questions(omp)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ dismissLabel: expect.anything() })]),
    );
  });

  test("keeps multi-select answers distinct when a label joins other labels", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const html =
      '<form><label><input type="checkbox" name="r" value="us">US</label><label><input type="checkbox" name="r" value="ca">Canada</label><label><input type="checkbox" name="r" value="both">US, Canada</label></form>';
    form(omp, "form-1", html);
    form(omp, "form-2", html);

    expect(questions(omp)).toMatchObject([
      { options: [{ label: "US" }, { label: "Canada" }, { label: "US,Canada" }] },
    ]);
    // The card joins checked labels with ", ".
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { r: "US, Canada" } },
    });
    await omp.respondToPermission("form-2", {
      behavior: "allow",
      updatedInput: { answers: { r: "US,Canada" } },
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { r: ["us", "ca"] } } },
      { id: "form-2", response: { data: { r: ["both"] } } },
    ]);
  });

  test("offers None so an optional multi-select without a text input can submit no choices", async () => {
    const omp = new OmpHarness();
    await omp.start();
    const html =
      '<form><label>Tools <select name="tools" multiple><option value="d">Docker</option><option value="k">Kubernetes</option></select></label><label>Must <select name="must" multiple required><option value="a">A</option><option value="b">B</option></select></label></form>';
    form(omp, "form-1", html);
    form(omp, "form-2", html);

    expect(questions(omp)).toMatchObject([
      {
        header: "tools",
        options: [{ label: "Docker" }, { label: "Kubernetes" }, { label: "None" }],
        allowOther: false,
      },
      { header: "must", options: [{ label: "A" }, { label: "B" }] },
    ]);
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { tools: "None", must: "A" } },
    });
    await omp.respondToPermission("form-2", {
      behavior: "allow",
      updatedInput: { answers: { tools: "Docker, None", must: "B" } },
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { tools: [], must: ["a"] } } },
      { id: "form-2", response: { data: { tools: ["d"], must: ["b"] } } },
    ]);
  });

  test("reads an option's text value the way OMP does when it wraps across lines", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(
      omp,
      "form-1",
      '<form><label>Region <select name="region"><option>Europe</option><option>North\n  America</option></select></label></form>',
    );

    expect(questions(omp)).toMatchObject([
      { options: [{ label: "Europe", description: "Default" }, { label: "North America" }] },
    ]);
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { region: "North America" } },
    });
    expect(omp.extensionUiResponses()).toEqual([
      { id: "form-1", response: { data: { region: "North America" } } },
    ]);
  });

  test("shows a form without controls as readable text with a Continue answer", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(
      omp,
      "form-1",
      "<form><p>Deploy <b>finished</b>.</p><ul><li>web</li><li>api</li></ul></form>",
    );

    expect(questions(omp)).toEqual([
      {
        question: "Deploy finished.\n\n- web\n- api",
        header: "Response",
        options: [{ label: "Continue" }],
        multiSelect: false,
        allowOther: false,
        allowEmpty: false,
      },
    ]);
    await omp.respondToPermission("form-1", {
      behavior: "allow",
      updatedInput: { answers: { Response: "Continue" } },
    });
    expect(omp.extensionUiResponses()).toEqual([{ id: "form-1", response: { data: {} } }]);
  });

  test("keeps malformed HTML readable instead of dropping the form", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(
      omp,
      "form-1",
      "<form><p>Pick one<label><input type=radio name=pick value=a>A<label><input type=radio name=pick value=b>B",
    );

    expect(questions(omp)).toMatchObject([
      { question: "Pick one", header: "pick", options: [{ label: "A" }, { label: "B" }] },
    ]);
  });

  test("cancels a form request without HTML instead of leaving OMP waiting", async () => {
    const omp = new OmpHarness();
    await omp.start();
    form(omp, "form-1", undefined);

    expect(omp.pendingPermissions()).toEqual([]);
    expect(omp.extensionUiResponses()).toEqual([{ id: "form-1", response: { cancelled: true } }]);
  });
});
