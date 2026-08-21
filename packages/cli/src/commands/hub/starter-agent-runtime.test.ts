import { describe, expect, it } from "vitest";
import {
  availableStarterAgentRuntimes,
  suggestedStarterAgentRuntime,
} from "./starter-agent-runtime.js";

describe("starter agent runtime choices", () => {
  it.each([
    {
      name: "uses complete ready provider defaults as the suggestion",
      entries: [
        {
          provider: "codex",
          status: "ready" as const,
          enabled: true,
          label: "Codex",
          models: [
            { provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true },
            { provider: "codex", id: "gpt-5-mini", label: "GPT-5 mini" },
          ],
          modes: [
            { id: "read-only", label: "Read only" },
            { id: "full-access", label: "Full access" },
          ],
          defaultModeId: "full-access",
        },
      ],
      expected: [
        {
          provider: "codex",
          model: "gpt-5",
          mode: "read-only",
          label: "Codex · GPT-5 · Read only",
          suggested: false,
        },
        {
          provider: "codex",
          model: "gpt-5",
          mode: "full-access",
          label: "Codex · GPT-5 · Full access",
          suggested: true,
        },
        {
          provider: "codex",
          model: "gpt-5-mini",
          mode: "read-only",
          label: "Codex · GPT-5 mini · Read only",
          suggested: false,
        },
        {
          provider: "codex",
          model: "gpt-5-mini",
          mode: "full-access",
          label: "Codex · GPT-5 mini · Full access",
          suggested: false,
        },
      ],
    },
    {
      name: "excludes Claude when the daemon lists modes without a compatible default",
      entries: [
        {
          provider: "claude",
          status: "ready" as const,
          enabled: true,
          label: "Claude",
          models: [{ provider: "claude", id: "sonnet", label: "Sonnet", isDefault: true }],
          modes: [{ id: "auto", label: "Auto" }],
          defaultModeId: null,
        },
      ],
      expected: [],
    },
    {
      name: "excludes unavailable, disabled, and model-less providers",
      entries: [
        { provider: "claude", status: "unavailable" as const, enabled: true },
        { provider: "codex", status: "ready" as const, enabled: false, models: [] },
        { provider: "opencode", status: "ready" as const, enabled: true, models: [] },
      ],
      expected: [],
    },
  ])("$name", ({ entries, expected }) => {
    const runtimes = availableStarterAgentRuntimes(entries);
    expect(runtimes.map(({ key: _key, ...runtime }) => runtime)).toEqual(expected);
    const suggested = suggestedStarterAgentRuntime(runtimes);
    expect(suggested === undefined ? undefined : withoutKey(suggested)).toEqual(
      expected.find((runtime) => runtime.suggested),
    );
  });
});

function withoutKey({
  key: _key,
  ...runtime
}: ReturnType<typeof availableStarterAgentRuntimes>[number]) {
  return runtime;
}
