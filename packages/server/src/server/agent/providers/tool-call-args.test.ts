import { describe, expect, test } from "vitest";

import { parseToolArgs as parseOmpToolArgs } from "./omp/tool-call-detail.js";
import { parseToolArgs as parsePiToolArgs } from "./pi/tool-call-mapper.js";

// Models send `null` for optional arguments (captured in #7011: read offset/limit), which the
// runtimes treat as omitted. Rejecting them turned every such call into an unknown card.
describe.each([
  ["Pi", parsePiToolArgs],
  ["OMP", parseOmpToolArgs],
])("%s tool args with null optional values", (_provider, parseToolArgs) => {
  test.each([
    ["read", { path: "./preview.png", offset: null, limit: null }, { path: "./preview.png" }],
    ["bash", { command: "ls", timeout: null }, { command: "ls" }],
  ])("parses %s as its own tool kind", (toolName, rawArgs, args) => {
    expect(parseToolArgs(toolName, rawArgs)).toEqual({ kind: toolName, toolName, args });
  });
});
