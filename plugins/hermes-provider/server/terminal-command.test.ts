import type { AcpToolCallSnapshot } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { terminalCommand } from "./terminal-command.js";

const FULL_COMMAND =
  'echo "whoami: $(whoami)" && id -u && echo cleaned && ls -la /tmp | head -3 && date +%Y && uname -s';

function text(value: string): AcpToolCallSnapshot["content"] {
  return [{ type: "content", content: { type: "text", text: value } }];
}

// Shapes captured from `hermes acp` (hermes-agent 8da31006f3) running its terminal tool.
const started: AcpToolCallSnapshot = {
  id: "call_95ed298464d44b0c9a23d24e72c96afc",
  title: 'terminal: echo "whoami: $(whoami)" + 5 commands',
  kind: "execute",
  status: "pending",
  input: null,
  output: null,
  content: text(`$ ${FULL_COMMAND}`),
  locations: [],
};

const completed: AcpToolCallSnapshot = {
  ...started,
  status: "completed",
  content: text("terminal result\n- **output:** whoami: moboudra\n- **exit_code:** 0"),
};

function present(call: AcpToolCallSnapshot, previous?: AcpToolCallSnapshot) {
  return terminalCommand.toolCall!(call, { sessionId: "session-1", previous });
}

describe("Hermes terminal calls", () => {
  it("runs the command from the start text, not the summary title", () => {
    expect(present(started).input).toEqual({ command: FULL_COMMAND });
  });

  it("keeps the command once the result replaces the start text", () => {
    const first = present(started);
    expect(present(completed, first).input).toEqual({ command: FULL_COMMAND });
  });

  it("prefers a command Hermes sends as input", () => {
    const call = { ...started, input: { command: "git status" } };
    expect(present(call)).toEqual(call);
  });

  it.each([
    { name: "a start text without the prompt", content: text(`Running ${FULL_COMMAND}`) },
    { name: "no start text", content: undefined },
    { name: "an unexpected content shape", content: { text: `$ ${FULL_COMMAND}` } },
  ])("passes the call through for $name", ({ content }) => {
    const call = { ...started, content };
    expect(present(call)).toEqual(call);
  });

  it("leaves other tools alone", () => {
    const read = { ...started, kind: "read", content: text("$ not a command") };
    expect(present(read)).toEqual(read);
  });
});
