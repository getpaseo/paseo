import { describe, expect, expectTypeOf, it } from "vitest";
import type { ComponentProps } from "react";
import type {
  StreamedText,
  StreamedTextProps,
  Modal,
  ModalProps,
  SettingsSection,
  SettingsSectionProps,
} from "./ui.js";
import { z } from "zod";
import { defineAttachmentSource, defineRpc, type RpcInput, type RpcOutput } from "../index.js";
import { callPluginRpc, searchPluginAttachments } from "./host.js";

const contract = defineRpc({
  name: "increment",
  input: z.unknown().pipe(z.object({ value: z.number() })),
  output: z.object({ value: z.number() }),
});

describe("plugin RPC contracts", () => {
  it("derives handler input and output types from a contract", () => {
    expectTypeOf<RpcInput<typeof contract>>().toEqualTypeOf<{ value: number }>();
    expectTypeOf<RpcOutput<typeof contract>>().toEqualTypeOf<{ value: number }>();
  });

  it("sends input unchanged for the plugin to parse", async () => {
    let parses = 0;
    const transformed = defineRpc({
      name: "transformed",
      input: z.string().transform((text) => {
        parses += 1;
        return Number(text);
      }),
      output: z.number(),
    });
    const invoke = async (_method: string, input: unknown) => {
      expect(input).toBe("2");
      expect(parses).toBe(0);
      return transformed.input.parseAsync(input);
    };
    await expect(callPluginRpc(transformed, invoke, "2")).resolves.toBe(2);
    expect(parses).toBe(1);
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

describe("plugin UI contracts", () => {
  it("exposes presentation capabilities from the UI entry", () => {
    expectTypeOf<ComponentProps<typeof StreamedText>>().toEqualTypeOf<StreamedTextProps>();
    expectTypeOf<ComponentProps<typeof Modal>>().toEqualTypeOf<ModalProps>();
    expectTypeOf<ComponentProps<typeof SettingsSection>>().toEqualTypeOf<SettingsSectionProps>();
    expectTypeOf<StreamedTextProps["phase"]>().toEqualTypeOf<"streaming" | "complete">();
  });
});
