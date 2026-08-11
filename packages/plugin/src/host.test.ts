import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAttachmentSource, defineRpc } from "./index.js";
import { callPluginRpc, searchPluginAttachments } from "./host.js";

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

describe("plugin attachment sources", () => {
  const search = defineRpc({
    name: "issues.search",
    input: z.object({ query: z.string() }),
    output: z.object({
      items: z.array(
        z.object({
          id: z.string(),
          identifier: z.string(),
          title: z.string(),
          subtitle: z.string().optional(),
          url: z.string(),
          text: z.string(),
          resourceType: z.string(),
        }),
      ),
    }),
  });

  it("searches through the declared RPC and validates the standard result", async () => {
    const source = defineAttachmentSource({
      id: "issues",
      title: "Issue",
      icon: "CircleDot",
      pickerTitle: "Attach issue",
      searchPlaceholder: "Search",
      search,
    });

    const payload = await searchPluginAttachments(
      source,
      async (method, input) => ({
        items: [
          {
            id: "issue-1",
            identifier: `${method}:${String(Reflect.get(input as object, "query"))}`,
            title: "Plugin attachments",
            url: "https://example.com/issues/1",
            text: "Issue snapshot",
            resourceType: "issue",
          },
        ],
      }),
      "ENG-123",
    );

    expect(payload.items[0]?.identifier).toBe("issues.search:ENG-123");
  });

  it("rejects a malformed standard search result", async () => {
    const source = defineAttachmentSource({
      id: "issues",
      title: "Issue",
      icon: "CircleDot",
      pickerTitle: "Attach issue",
      searchPlaceholder: "Search",
      search,
    });

    await expect(
      searchPluginAttachments(source, async () => ({ items: [{ id: "issue-1" }] }), "issue"),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});
