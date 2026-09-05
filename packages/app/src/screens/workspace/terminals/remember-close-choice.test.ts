import { describe, expect, it } from "vitest";
import { rememberTerminalCloseChoice } from "./remember-close-choice";

describe("rememberTerminalCloseChoice", () => {
  it("reports success and stays quiet when the preference is written", async () => {
    const failures: unknown[] = [];
    let persisted = 0;

    const stored = await rememberTerminalCloseChoice({
      persist: async () => {
        persisted += 1;
      },
      onFailure: (error) => failures.push(error),
    });

    expect(stored).toBe(true);
    expect(persisted).toBe(1);
    expect(failures).toEqual([]);
  });

  it("surfaces the rejection instead of leaving an unhandled promise", async () => {
    const writeError = new Error("quota exceeded");
    const failures: unknown[] = [];

    const stored = await rememberTerminalCloseChoice({
      persist: async () => {
        throw writeError;
      },
      onFailure: (error) => failures.push(error),
    });

    expect(stored).toBe(false);
    expect(failures).toEqual([writeError]);
  });
});
