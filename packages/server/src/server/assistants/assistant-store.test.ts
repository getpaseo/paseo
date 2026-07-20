import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { AssistantStore } from "./assistant-store.js";

describe("AssistantStore", () => {
  let paseoHome: string;
  let store: AssistantStore;

  beforeEach(async () => {
    paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-assistant-store-"));
    store = new AssistantStore({ paseoHome, logger: pino({ level: "silent" }) });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("creates, updates, and deletes assistants", () => {
    const assistant = store.create({
      name: "Reviewer",
      description: "Reviews pull requests",
      prompt: "Review code carefully.",
      memoryEnabled: true,
      memory:
        "# Style\nPrefer concise feedback.\n\n# Repository\nThe API package owns shared wire types.",
    });

    expect(store.list()).toHaveLength(1);
    expect(assistant).toMatchObject({
      name: "Reviewer",
      memoryEnabled: true,
    });
    expect(assistant.memorySummary).toContain("Assistant memory summary");
    expect(assistant.memorySummary).toContain("Style");
    expect(assistant.memorySummary).toContain("Detail file index");
    expect(assistant.memorySummary).not.toContain("The API package owns shared wire types.");
    expect(assistant.memoryFiles.summaryPath.endsWith("summary.md")).toBe(true);
    expect(assistant.memoryFiles.detailFiles.length).toBeGreaterThan(0);
    const detailPath = assistant.memoryFiles.detailFiles[0]?.path;
    expect(detailPath).toBeTruthy();
    expect(readFileSync(detailPath!, "utf8")).toContain("Prefer concise feedback.");
    expect(assistant.memoryFiles.detailFiles[0]?.content).toContain("Prefer concise feedback.");

    const updated = store.update({ id: assistant.id, name: "Code Reviewer" });
    expect(updated).toMatchObject({ name: "Code Reviewer" });
    expect(store.get(assistant.id)?.name).toBe("Code Reviewer");

    expect(store.delete(assistant.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(existsSync(detailPath!)).toBe(false);
  });

  test("materializes summary and detail files for legacy stored memory", () => {
    const legacyPayload = {
      version: 1,
      assistants: [
        {
          id: "assistant-legacy",
          name: "Legacy",
          description: "",
          prompt: "Help.",
          memoryEnabled: true,
          memory:
            "# Preferences\nPrefer tests before refactors.\n\n# Details\n1. Keep changelogs short.\n\n1. Keep changelogs short.",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(path.join(paseoHome, "assistants.json"), JSON.stringify(legacyPayload));

    const loaded = new AssistantStore({ paseoHome, logger: pino({ level: "silent" }) });
    const [assistant] = loaded.list();

    expect(assistant?.memorySummary).toContain("Assistant memory summary");
    expect(assistant?.memorySummary).toContain("Preferences");
    expect(assistant?.memoryFiles.detailFiles).toHaveLength(2);
    expect(existsSync(assistant!.memoryFiles.summaryPath)).toBe(true);
    expect(readFileSync(assistant!.memoryFiles.detailFiles[0]!.path, "utf8")).toContain(
      "Prefer tests before refactors.",
    );
    expect(readFileSync(assistant!.memoryFiles.detailFiles[1]!.path, "utf8")).toContain(
      "Keep changelogs short.",
    );
    expect(assistant?.memory.match(/Keep changelogs short/g)).toHaveLength(1);
  });

  test("appends assistant memory without overwriting existing memory and keeps heading types separate", () => {
    const assistant = store.create({
      name: "Reviewer",
      prompt: "Review code carefully.",
      memoryEnabled: true,
      memory: "# Existing\nPrefer concise feedback.",
    });

    const appended = store.update({
      id: assistant.id,
      memoryEnabled: true,
      memoryAppend: "# New\nMention risky migrations.",
    });

    expect(appended?.memory).toContain("Prefer concise feedback.");
    expect(appended?.memory).toContain("Mention risky migrations.");
    expect(appended?.memory).toMatch(/feedback\.\n\n# New/);
    expect(appended?.memoryFiles.detailFiles[0]?.content).toContain("Prefer concise feedback.");
    expect(appended?.memoryFiles.detailFiles[0]?.content).not.toContain(
      "Mention risky migrations.",
    );
    expect(appended?.memoryFiles.detailFiles[1]?.title).toBe("New");
    expect(appended?.memoryFiles.detailFiles[1]?.content).toContain("Mention risky migrations.");

    const unchanged = store.update({
      id: assistant.id,
      memoryEnabled: true,
      memoryAppend: "   ",
    });
    expect(unchanged?.memory).toBe(appended?.memory);
  });

  test("merges repeated memory headings into one detail file and keeps summary headings unique", () => {
    const assistant = store.create({
      name: "Reviewer",
      prompt: "Review code carefully.",
      memoryEnabled: true,
      memory: "# Preferences\nPrefer concise feedback.",
    });

    const appended = store.update({
      id: assistant.id,
      memoryAppend: "# Preferences\nPrefer tests before refactors.",
    });

    expect(appended?.memoryFiles.detailFiles).toHaveLength(1);
    expect(appended?.memoryFiles.detailFiles[0]?.title).toBe("Preferences");
    expect(appended?.memoryFiles.detailFiles[0]?.content).toContain("Prefer concise feedback.");
    expect(appended?.memoryFiles.detailFiles[0]?.content).toContain(
      "Prefer tests before refactors.",
    );
    const preferencesHeadings =
      appended?.memoryFiles.detailFiles[0]?.content.match(/^# Preferences$/gm) ?? [];
    expect(preferencesHeadings).toHaveLength(1);
    expect(appended?.memorySummary.match(/- Preferences/g)).toHaveLength(1);
  });

  test("deduplicates repeated memory detail list entries", () => {
    const duplicatedLine = "1. 生活服务结算包括计费、分账、退分账领域";
    const assistant = store.create({
      name: "结算助手",
      prompt: "回答结算问题。",
      memoryEnabled: true,
      memory: [
        "# 结算知识",
        duplicatedLine,
        duplicatedLine,
        duplicatedLine,
        duplicatedLine,
        "1. 分账域的服务有：life.settle.ledger、life.settle.ledger_platform",
      ].join("\n\n"),
    });

    expect(assistant.memoryFiles.detailFiles).toHaveLength(1);
    const detailContent = assistant.memoryFiles.detailFiles[0]?.content ?? "";
    expect(detailContent.match(/生活服务结算包括计费、分账、退分账领域/g)).toHaveLength(1);
    expect(assistant.memory.match(/生活服务结算包括计费、分账、退分账领域/g)).toHaveLength(1);
    expect(detailContent).toContain(
      "2. 分账域的服务有：life.settle.ledger、life.settle.ledger_platform",
    );
  });

  test("deduplicates similar troubleshooting steps and renumbers ordered memory lists", () => {
    const assistant = store.create({
      name: "结算助手",
      prompt: "回答结算问题。",
      memoryEnabled: true,
      memory: [
        "1. 先确定问题领域",
        "排查问题步骤\n1. 确定问题领域\n2. 根据领域确定服务psm。比如：1. 生活服务结算包括计费、分账、退分账领域",
        "1. 分账域的服务有：life.settle.ledger、life.settle.ledger_platform",
        "1. 退分账域的服务有：life.settle.ledger",
      ].join("\n\n"),
    });

    expect(assistant.memory).not.toContain("先确定问题领域");
    expect(assistant.memory.match(/确定问题领域/g)).toHaveLength(1);
    expect(assistant.memory).toContain(
      [
        "排查问题步骤",
        "1. 确定问题领域",
        "2. 根据领域确定服务psm。比如：1. 生活服务结算包括计费、分账、退分账领域",
        "",
        "3. 分账域的服务有：life.settle.ledger、life.settle.ledger_platform",
        "",
        "4. 退分账域的服务有：life.settle.ledger",
      ].join("\n"),
    );

    const detailContent = assistant.memoryFiles.detailFiles[0]?.content ?? "";
    expect(detailContent).toContain("1. 确定问题领域");
    expect(detailContent).toContain(
      "2. 根据领域确定服务psm。比如：1. 生活服务结算包括计费、分账、退分账领域",
    );
    expect(detailContent).toContain(
      "3. 分账域的服务有：life.settle.ledger、life.settle.ledger_platform",
    );
    expect(detailContent).toContain("4. 退分账域的服务有：life.settle.ledger");
    expect(detailContent).not.toContain("1. 先确定问题领域");
  });

  test("does not append generated memory summary sections back into source memory", () => {
    const assistant = store.create({
      name: "Reviewer",
      prompt: "Review code carefully.",
      memoryEnabled: true,
      memory: "# Existing\nPrefer concise feedback.",
    });

    const appended = store.update({
      id: assistant.id,
      memoryAppend: `${assistant.memorySummary}\n\n# Repository\nThe API package owns shared wire types.`,
    });

    expect(appended?.memory).not.toContain("## Memory headings");
    expect(appended?.memory).not.toContain("## Detail file index");
    expect(appended?.memoryFiles.detailFiles).toHaveLength(2);
    expect(appended?.memoryFiles.detailFiles.map((file) => file.title)).toEqual([
      "Existing",
      "Repository",
    ]);
    expect(appended?.memorySummary.match(/^## Memory headings$/gm)).toHaveLength(1);
    expect(appended?.memorySummary).not.toContain("- Memory headings");
  });

  test("edits materialized summary and detail files without overwriting source memory", () => {
    const assistant = store.create({
      name: "Reviewer",
      prompt: "Review code carefully.",
      memoryEnabled: true,
      memory: "# Existing\nPrefer concise feedback.",
    });
    const detailFile = assistant.memoryFiles.detailFiles[0]!;
    const originalMemory = assistant.memory;

    const edited = store.update({
      id: assistant.id,
      memorySummary: "# Edited summary\n\nUse edited summary only.",
      memoryDetailFileEdits: [
        {
          id: detailFile.id,
          content: "# Edited detail\n\nPrefer actionable comments.",
        },
      ],
    });

    expect(edited?.memory).toBe(originalMemory);
    expect(edited?.memorySummary).toBe("# Edited summary\n\nUse edited summary only.");
    expect(readFileSync(edited!.memoryFiles.summaryPath, "utf8")).toBe(
      "# Edited summary\n\nUse edited summary only.",
    );
    expect(edited?.memoryFiles.detailFiles[0]?.content).toBe(
      "# Edited detail\n\nPrefer actionable comments.",
    );
    expect(edited?.memoryFiles.detailFiles[0]?.title).toBe("Edited detail");
    expect(edited?.memoryFiles.detailFiles[0]?.charCount).toBe(
      "# Edited detail\n\nPrefer actionable comments.".length,
    );
    expect(readFileSync(detailFile.path, "utf8")).toBe(
      "# Edited detail\n\nPrefer actionable comments.",
    );

    const renamed = store.update({ id: assistant.id, name: "Renamed Reviewer" });
    expect(renamed?.memorySummary).toBe("# Edited summary\n\nUse edited summary only.");
    expect(renamed?.memoryFiles.detailFiles[0]?.content).toBe(
      "# Edited detail\n\nPrefer actionable comments.",
    );
  });
});
