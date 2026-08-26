import { describe, expect, it } from "vitest";
import type { AgentMcpServerStatus } from "@getpaseo/protocol/agent-types";
import { getMcpStatusPresentation } from "./status";

describe("getMcpStatusPresentation", () => {
  it("leaves a connected server's status unlabelled", () => {
    expect(getMcpStatusPresentation("connected")).toEqual({ tone: "success", labelKey: null });
  });

  it("separates the two states a reader must act on", () => {
    expect(getMcpStatusPresentation("needs_auth").tone).toBe("warning");
    expect(getMcpStatusPresentation("failed").tone).toBe("danger");
  });

  it("mutes the states that are neither healthy nor faults", () => {
    expect(getMcpStatusPresentation("connecting").tone).toBe("muted");
    expect(getMcpStatusPresentation("disabled").tone).toBe("muted");
    expect(getMcpStatusPresentation("unknown").tone).toBe("muted");
  });

  it("falls back to unknown for a status the daemon has but the app does not", () => {
    const rogue = "quantum-entangled" as AgentMcpServerStatus;
    expect(getMcpStatusPresentation(rogue)).toEqual(getMcpStatusPresentation("unknown"));
  });
});
