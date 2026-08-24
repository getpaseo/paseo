/**
 * Output schemas for `paseo browser` results.
 *
 * Table output reuses the daemon's own human summary so it reads exactly like the MCP tool
 * response, while JSON/YAML expose the tool's structuredContent unchanged.
 */

import type { BrowserToolName } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { OutputSchema, SingleResult } from "../../output/index.js";
import type { BrowserToolCallResult, BrowserToolStructuredContent } from "./shared.js";

export interface BrowserResultRow {
  tool: string;
  ok: boolean;
  browserId: string | undefined;
  summary: string;
  structuredContent: BrowserToolStructuredContent | undefined;
}

export const browserResultSchema: OutputSchema<BrowserResultRow> = {
  idField: (row) => row.browserId ?? row.tool,
  columns: [
    { header: "TOOL", field: "tool", width: 22 },
    { header: "BROWSER", field: (row) => row.browserId ?? "-", width: 26 },
    { header: "SUMMARY", field: "summary", width: 60 },
  ],
  renderHuman: (result) =>
    result.type === "single"
      ? result.data.summary
      : result.data.map((row) => row.summary).join("\n"),
  serialize: (row) => row.structuredContent ?? { ok: row.ok, summary: row.summary },
};

export function toBrowserResult(
  tool: BrowserToolName,
  result: BrowserToolCallResult,
): SingleResult<BrowserResultRow> {
  const browserId = result.structuredContent?.result?.browserId;
  return {
    type: "single",
    data: {
      tool,
      ok: result.ok,
      browserId: typeof browserId === "string" ? browserId : undefined,
      summary: result.text,
      structuredContent: result.structuredContent,
    },
    schema: browserResultSchema,
  };
}

export interface BrowserTabRow {
  browserId: string;
  title: string;
  url: string;
  isActive: boolean;
  isLoading: boolean;
}

export const browserTabSchema: OutputSchema<BrowserTabRow> = {
  idField: "browserId",
  columns: [
    { header: "BROWSER ID", field: "browserId", width: 26 },
    { header: "ACTIVE", field: (row) => (row.isActive ? "yes" : "no"), width: 6 },
    { header: "TITLE", field: "title", width: 32 },
    { header: "URL", field: "url", width: 48 },
  ],
};
