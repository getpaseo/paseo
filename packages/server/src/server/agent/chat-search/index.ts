import MarkdownIt from "markdown-it";
import { setImmediate } from "node:timers/promises";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { projectTimelineRows } from "../timeline-projection.js";

const markdown = new MarkdownIt({ html: false });
const PAGE_SIZE = 200;
interface SearchLocation {
  seq: number;
  role: "user" | "assistant";
}
interface SearchInput {
  rows: readonly AgentTimelineRow[];
  query: string;
  cursor?: number;
}

// Discovery is deliberately approximate. Only the client can verify displayed text.
function searchableMarkdown(text: string): string {
  return markdown
    .parse(text, {})
    .map((token) => {
      if (token.type === "inline") {
        return (token.children ?? [])
          .map((child) => {
            if (child.type === "text" || child.type === "code_inline") return child.content;
            if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
            return "";
          })
          .join("");
      }
      if (token.type === "fence" || token.type === "code_block") return token.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function searchTimeline({ rows, query, cursor = 0 }: SearchInput) {
  const locations: SearchLocation[] = [];
  if (!query.trim()) return { locations, nextCursor: null };
  const needle = normalizeSearchText(query);
  let lastYield = performance.now();
  for (const entry of projectTimelineRows({ rows, mode: "projected" })) {
    if (entry.seqEnd <= cursor) continue;
    const item = entry.item;
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const raw = item.text.replace(/\r/g, "");
    const text = item.type === "assistant_message" ? searchableMarkdown(raw) : raw;
    if (normalizeSearchText(raw).includes(needle) || normalizeSearchText(text).includes(needle)) {
      if (locations.length === PAGE_SIZE) {
        return { locations, nextCursor: locations[PAGE_SIZE - 1]!.seq };
      }
      locations.push({
        seq: entry.seqEnd,
        role: item.type === "user_message" ? "user" : "assistant",
      });
    }
    if (performance.now() - lastYield >= 8) {
      await setImmediate();
      lastYield = performance.now();
    }
  }
  return { locations, nextCursor: null };
}

function normalizeSearchText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}
