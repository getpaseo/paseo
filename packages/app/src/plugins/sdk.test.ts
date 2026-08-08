import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callPluginRpc, defineRpc } from "./sdk";

const contract = defineRpc({
  name: "increment",
  input: z.unknown().pipe(z.object({ value: z.number() })),
  output: z.object({ value: z.number() }),
});

describe("plugin RPC contracts", () => {
  it("validates input before invoking the daemon", async () => {
    let invocations = 0;
    const invoke = async () => {
      invocations += 1;
      return { value: 2 };
    };

    await expect(callPluginRpc(contract, invoke, { value: "wrong" })).rejects.toBeInstanceOf(
      z.ZodError,
    );
    expect(invocations).toBe(0);
  });

  it("validates output before resolving", async () => {
    const invoke = async () => ({ value: "wrong" });

    await expect(callPluginRpc(contract, invoke, { value: 1 })).rejects.toBeInstanceOf(z.ZodError);
  });

  it("returns parsed output for a valid invocation", async () => {
    const invoke = async (method: string, input: unknown) => ({
      value: method === "increment" && typeof input === "object" ? 2 : 0,
    });

    await expect(callPluginRpc(contract, invoke, { value: 1 })).resolves.toEqual({ value: 2 });
  });
});
