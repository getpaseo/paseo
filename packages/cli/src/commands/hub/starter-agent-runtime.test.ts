import { describe, expect, it } from "vitest";
import {
  availableStarterAgentProviders,
  selectedStarterAgentRuntime,
  suggestedStarterAgentChoice,
} from "./starter-agent-runtime.js";

describe("starter agent runtime choices", () => {
  it.each([
    {
      name: "uses a complete daemon default as a staged suggestion",
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
          id: "codex",
          label: "Codex",
          suggested: true,
          models: [
            { id: "gpt-5", label: "GPT-5", suggested: true },
            { id: "gpt-5-mini", label: "GPT-5 mini", suggested: false },
          ],
          modes: [
            { id: "read-only", label: "Read only", suggested: false },
            { id: "full-access", label: "Full access", suggested: true },
          ],
        },
      ],
    },
    {
      name: "keeps Claude selectable when it has modes but no default mode",
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
      expected: [
        {
          id: "claude",
          label: "Claude",
          suggested: false,
          models: [{ id: "sonnet", label: "Sonnet", suggested: true }],
          modes: [{ id: "auto", label: "Auto", suggested: false }],
        },
      ],
    },
    {
      name: "treats an invalid default mode as no suggestion",
      entries: [
        {
          provider: "claude",
          status: "ready" as const,
          enabled: true,
          models: [{ provider: "claude", id: "sonnet", label: "Sonnet", isDefault: true }],
          modes: [{ id: "auto", label: "Auto" }],
          defaultModeId: "missing",
        },
      ],
      expected: [
        {
          id: "claude",
          label: "claude",
          suggested: false,
          models: [{ id: "sonnet", label: "Sonnet", suggested: true }],
          modes: [{ id: "auto", label: "Auto", suggested: false }],
        },
      ],
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
    expect(availableStarterAgentProviders(entries)).toEqual(expected);
  });

  it("creates mode-less definitions for providers that expose no modes", () => {
    const [provider] = availableStarterAgentProviders([
      {
        provider: "pi",
        status: "ready",
        enabled: true,
        models: [{ provider: "pi", id: "default", label: "Default", isDefault: true }],
        modes: [],
      },
    ]);

    expect(provider).toBeDefined();
    expect(selectedStarterAgentRuntime(provider!, "default")).toEqual({
      provider: "pi",
      model: "default",
    });
    expect(suggestedStarterAgentChoice(provider!.modes)).toBeUndefined();
  });
});
