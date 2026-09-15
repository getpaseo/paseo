import { describe, expect, it } from "vitest";
import { resolveLaunchTarget } from "@/new-workspace-launch/target";
import { parseFormPreferences } from "@/create-agent-preferences/preferences";

describe("workspace intention", () => {
  it("round trips the target only on a capable host", () => {
    const target = { kind: "intention" } as const;
    expect(parseFormPreferences({ launchTarget: target }).launchTarget).toEqual(target);
    expect(resolveLaunchTarget(target, [], true)).toEqual(target);
    expect(resolveLaunchTarget(target, [], false)).toEqual({ kind: "chat" });
  });
});
