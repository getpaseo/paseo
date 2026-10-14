import { describe, expect, it } from "vitest";
import { LocalUpdatePolicy } from "./local-update-policy";

describe("local update activation", () => {
  it("waits for idle, counts down, cancels on interaction and supports postponing", () => {
    const policy = new LocalUpdatePolicy("old", 0);
    policy.installed("new");
    expect(policy.tick(59_999).phase).toBe("ready");
    expect(policy.tick(60_000)).toMatchObject({ phase: "countdown", deadline: 70_000 });
    policy.activity(65_000);
    expect(policy.tick(70_000).phase).toBe("ready");
    expect(policy.tick(125_000).phase).toBe("countdown");
    policy.postpone(126_000);
    expect(policy.tick(126_000 + 1_799_999).phase).toBe("ready");
    expect(policy.tick(126_000 + 1_800_000).phase).toBe("countdown");
  });
});

it("cancels activation when input arrives while drafts are flushing", () => {
  const policy = new LocalUpdatePolicy("old", 0);
  policy.installed("new");
  policy.tick(60_000);
  expect(policy.tick(70_000).phase).toBe("activating");
  policy.activity(70_001);
  expect(policy.tick(70_002).phase).toBe("ready");
});
it("does not retry a failed build on every poll", () => {
  const policy = new LocalUpdatePolicy("old", 0);
  policy.installed("new");
  policy.fail("failed");
  policy.installed("new");
  expect(policy.tick(1_000_000).phase).toBe("error");
});
