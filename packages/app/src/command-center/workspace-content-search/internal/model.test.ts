import { expect, test } from "vitest";
import type { FileReadResult } from "@getpaseo/client";
import type {
  WorkspaceContentMatch,
  WorkspaceContentSearchResult,
} from "@getpaseo/protocol/messages";
import { WorkspaceContentSearchModel, type ContentSearchTransport } from "./model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function match(path: string, text = "NEEDLE"): WorkspaceContentMatch {
  return {
    path,
    line: 1,
    columnStart: 1,
    columnEnd: text.length + 1,
    text,
    snippet: text,
    snippetMatchStart: 0,
    snippetMatchEnd: text.length,
  };
}
function result(matches: WorkspaceContentMatch[]): WorkspaceContentSearchResult {
  return { status: "ok", matches, limited: false };
}
function file(path: string, text: string): FileReadResult {
  return {
    path,
    kind: "text",
    mime: "text/plain",
    bytes: new TextEncoder().encode(text),
    size: text.length,
    modifiedAt: "2026-09-09",
  };
}

test("obsolete queries cannot restore results and opening carries the original case-insensitive match", async () => {
  const first = deferred<WorkspaceContentSearchResult>();
  const second = deferred<WorkspaceContentSearchResult>();
  const startedFirst = deferred<void>();
  const startedSecond = deferred<void>();
  const signals: AbortSignal[] = [];
  const opened: unknown[] = [];
  const transport: ContentSearchTransport = {
    searchWorkspaceContent: ({ query }, { signal }) => {
      signals.push(signal);
      if (query === "old") {
        startedFirst.resolve();
        return first.promise;
      }
      startedSecond.resolve();
      return second.promise;
    },
    readFile: async (path) => file(path, "NEEDLE"),
  };
  const model = new WorkspaceContentSearchModel({
    cwd: "/workspace",
    transport,
    open: (location) => opened.push(location),
    debounceMs: 0,
  });
  try {
    model.setQuery("old");
    await startedFirst.promise;
    model.setQuery("needle");
    await startedSecond.promise;
    expect(signals[0].aborted).toBe(true);
    second.resolve(result([match("a.ts")]));
    await Promise.resolve();
    await Promise.resolve();
    first.resolve(result([match("obsolete.ts")]));
    await Promise.resolve();
    expect(model.getSnapshot()).toMatchObject({
      query: "needle",
      status: "ready",
      matches: [match("a.ts")],
      preview: { status: "ready", content: "NEEDLE" },
    });
    model.openSelected();
    expect(opened).toEqual([
      { path: "a.ts", lineStart: 1, columnStart: 1, columnEnd: 7, expectedText: "NEEDLE" },
    ]);
  } finally {
    model.dispose();
  }
});

test("selection bounds preview work to one read plus the latest target, and reads current saved content", async () => {
  const started = deferred<void>();
  const searched = deferred<WorkspaceContentSearchResult>();
  const a = deferred<FileReadResult>();
  const c = deferred<FileReadResult>();
  const paths: string[] = [];
  const model = new WorkspaceContentSearchModel({
    cwd: "/workspace",
    debounceMs: 0,
    open() {},
    transport: {
      searchWorkspaceContent: () => {
        started.resolve();
        return searched.promise;
      },
      readFile: (_cwd, path) => {
        paths.push(path);
        return path === "a" ? a.promise : c.promise;
      },
    },
  });
  try {
    model.setQuery("needle");
    await started.promise;
    searched.resolve(result([match("a"), match("b"), match("c")]));
    await Promise.resolve();
    model.select(1);
    model.select(2);
    expect(paths).toEqual(["a"]);
    a.resolve(file("a", "NEEDLE"));
    await Promise.resolve();
    expect(paths).toEqual(["a", "c"]);
    c.resolve(file("c", "changed"));
    await Promise.resolve();
    expect(model.getSnapshot().preview).toMatchObject({
      status: "ready",
      path: "c",
      content: "changed",
    });
  } finally {
    model.dispose();
  }
});

test("a new query refreshes the saved preview even when its selected path is unchanged", async () => {
  const reads: Array<ReturnType<typeof deferred<FileReadResult>>> = [];
  const searches: Array<ReturnType<typeof deferred<WorkspaceContentSearchResult>>> = [];
  const model = new WorkspaceContentSearchModel({
    cwd: "/workspace",
    debounceMs: 0,
    open() {},
    transport: {
      searchWorkspaceContent: () => {
        const pending = deferred<WorkspaceContentSearchResult>();
        searches.push(pending);
        return pending.promise;
      },
      readFile: () => {
        const pending = deferred<FileReadResult>();
        reads.push(pending);
        return pending.promise;
      },
    },
  });
  try {
    model.setQuery("first");
    await expect.poll(() => searches.length).toBe(1);
    searches[0].resolve(result([match("same.ts")]));
    await Promise.resolve();
    model.setQuery("second");
    await expect.poll(() => searches.length).toBe(2);
    searches[1].resolve(result([match("same.ts")]));
    await Promise.resolve();
    reads[0].resolve(file("same.ts", "old saved text"));
    await Promise.resolve();
    expect(reads).toHaveLength(2);
    reads[1].resolve(file("same.ts", "NEEDLE current saved text"));
    await Promise.resolve();
    expect(model.getSnapshot().preview).toMatchObject({
      status: "ready",
      content: "NEEDLE current saved text",
    });
  } finally {
    model.dispose();
  }
});

test("textual image occurrences expose saved source without changing the read kind", async () => {
  const model = new WorkspaceContentSearchModel({
    cwd: "/workspace",
    debounceMs: 0,
    open() {},
    transport: {
      searchWorkspaceContent: async () => result([match("icon.svg")]),
      readFile: async () => ({
        ...file("icon.svg", "<svg>NEEDLE</svg>"),
        kind: "image",
        mime: "image/svg+xml",
      }),
    },
  });
  try {
    model.setQuery("needle");
    await expect.poll(() => model.getSnapshot().preview.status).toBe("ready");
    expect(model.getSnapshot().preview).toMatchObject({ content: "<svg>NEEDLE</svg>" });
  } finally {
    model.dispose();
  }
});

test("revisiting a file re-reads it, so a file deleted since the search stops previewing", async () => {
  const reads: string[] = [];
  let deleted = false;
  const model = new WorkspaceContentSearchModel({
    cwd: "/workspace",
    debounceMs: 0,
    open() {},
    transport: {
      searchWorkspaceContent: async () => result([match("a.ts"), match("b.ts")]),
      readFile: async (_cwd, path) => {
        reads.push(path);
        if (path === "a.ts" && deleted) throw new Error("ENOENT: no such file");
        return file(path, `NEEDLE in ${path}`);
      },
    },
  });
  try {
    model.setQuery("needle");
    await expect.poll(() => model.getSnapshot().preview.status).toBe("ready");
    expect(reads).toEqual(["a.ts"]);
    model.move(1);
    await expect.poll(() => reads).toEqual(["a.ts", "b.ts"]);
    deleted = true;
    model.move(-1);
    await expect.poll(() => model.getSnapshot().preview).toMatchObject({ status: "error" });
    expect(reads).toEqual(["a.ts", "b.ts", "a.ts"]);
  } finally {
    model.dispose();
  }
});
