import { expect, test } from "vitest";
import type {
  CodeDocument,
  CodeQuery,
  CodeQueryResult,
  CodeLocation,
} from "@getpaseo/protocol/code-language";
import { WorkspaceLanguage, type LanguageTransport } from "./model";

class MemoryTransport implements LanguageTransport {
  isConnected = true;
  documents: CodeDocument[] = [];
  queries: CodeQuery[] = [];
  cancelled: string[] = [];
  listener: (status: { status: string }) => void = () => {};
  result: Promise<CodeQueryResult> = Promise.resolve({
    kind: "hover",
    text: "number",
    range: null,
  });
  async syncCodeDocument(document: CodeDocument) {
    this.documents.push(document);
  }
  async queryCode(query: CodeQuery) {
    this.queries.push(query);
    return { result: await this.result, generation: "server-generation", version: query.version };
  }
  async cancelCodeQuery(id: string) {
    this.cancelled.push(id);
  }
  async getCodeSnippets(_cwd: string, _locations: CodeLocation[]) {
    return [];
  }
  subscribeConnectionStatus(listener: (status: { status: string }) => void) {
    this.listener = listener;
    return () => {
      this.listener = () => {};
    };
  }
}
const query = {
  path: "/repo/a.ts",
  position: { line: 0, character: 7 },
  operation: "hover" as const,
};

test("flushes all unsaved buffers before querying and replays after reconnect", async () => {
  const transport = new MemoryTransport();
  const scope = new WorkspaceLanguage(transport, "/repo");
  const a = scope.retain(query.path, "const a = 1;");
  const b = scope.retain("/repo/b.ts", "export const b = 2;");
  a.update("const a = 3;");
  expect((await scope.query(query, new AbortController().signal)).kind).toBe("hover");
  expect(transport.documents.map((document) => document.content)).toEqual([
    "const a = 3;",
    "export const b = 2;",
  ]);
  expect(transport.queries[0]?.version).toBe(transport.documents[0]?.version);
  transport.listener({ status: "disconnected" });
  transport.listener({ status: "connected" });
  await scope.query(query, new AbortController().signal);
  expect(transport.documents).toHaveLength(4);
  a.release();
  b.release();
  scope.dispose();
});
test("rejects a late response when another buffer changes", async () => {
  const transport = new MemoryTransport();
  const scope = new WorkspaceLanguage(transport, "/repo");
  const lease = scope.retain(query.path, "const a = 1;");
  let resolve: (result: CodeQueryResult) => void = () => {};
  transport.result = new Promise((done) => {
    resolve = done;
  });
  const pending = scope.query(query, new AbortController().signal);
  await scope.flush();
  lease.update("const a = 2;");
  resolve({ kind: "hover", text: "old", range: null });
  expect((await pending).kind).toBe("stale");
  lease.release();
  scope.dispose();
});
test("shares a document across leases and closes only after the last release", async () => {
  const transport = new MemoryTransport();
  const scope = new WorkspaceLanguage(transport, "/repo");
  const first = scope.retain(query.path, "const a = 1;");
  const second = scope.retain(query.path, "const a = 1;");
  await scope.flush();
  first.release();
  await scope.flush();
  expect(transport.documents).toHaveLength(1);
  second.release();
  await scope.flush();
  expect(transport.documents.at(-1)?.content).toBeNull();
  scope.dispose();
});
