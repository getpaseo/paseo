import type { ResolvedSharePayload, SharePayload } from "expo-sharing";
import { describe, expect, it } from "vitest";
import {
  coalesceRuns,
  describeIncomingShare,
  normalizeLocalFileUri,
  readIncomingShare,
  redirectShareIntakePath,
  type ShareSource,
} from "./model";

function fileResolved(input: {
  value: string;
  contentUri: string;
  name: string | null;
  mimeType: string;
  shareType?: ResolvedSharePayload["shareType"];
}): ResolvedSharePayload {
  return {
    value: input.value,
    shareType: input.shareType ?? "file",
    mimeType: input.mimeType,
    contentUri: input.contentUri,
    contentType: "file",
    contentMimeType: input.mimeType,
    originalName: input.name,
    contentSize: 1024,
  };
}

class FakeShareSource implements ShareSource {
  cleared = 0;
  resolveCalls = 0;

  constructor(
    private payloads: SharePayload[],
    private resolve: () => Promise<ResolvedSharePayload[]> = async () => [],
  ) {}

  getSharedPayloads(): SharePayload[] {
    return this.payloads;
  }

  getResolvedSharedPayloadsAsync(): Promise<ResolvedSharePayload[]> {
    this.resolveCalls += 1;
    return this.resolve();
  }

  clearSharedPayloads(): void {
    this.cleared += 1;
    this.payloads = [];
  }
}

const createId = () => "share-1";

describe("readIncomingShare", () => {
  it("reads a presentation shared from Android with its original name", async () => {
    const source = new FakeShareSource(
      [
        {
          value: "content://com.android.providers/document/42",
          shareType: "file",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      ],
      async () => [
        fileResolved({
          value: "content://com.android.providers/document/42",
          contentUri: "file:/data/user/0/sh.paseo/cache/5f1c-Quarterly review.pptx",
          name: "Quarterly review.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      ],
    );

    const read = await readIncomingShare(source, createId);

    expect(read).toEqual({
      share: {
        id: "share-1",
        text: "",
        files: [
          {
            uri: "file:///data/user/0/sh.paseo/cache/5f1c-Quarterly review.pptx",
            name: "Quarterly review.pptx",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          },
        ],
      },
      filesUnreadable: false,
    });
    expect(source.cleared).toBe(1);
  });

  it("treats an Android text file as a file, not as its URI in the prompt", async () => {
    const source = new FakeShareSource(
      [{ value: "content://downloads/notes.md", shareType: "text", mimeType: "text/markdown" }],
      async () => [
        fileResolved({
          value: "content://downloads/notes.md",
          shareType: "text",
          contentUri: "file:/data/cache/9a-notes.md",
          name: "notes.md",
          mimeType: "text/markdown",
        }),
      ],
    );

    const read = await readIncomingShare(source, createId);

    expect(read.share?.text).toBe("");
    expect(read.share?.files.map((file) => file.name)).toEqual(["notes.md"]);
  });

  it("keeps a shared link as text without resolving it over the network", async () => {
    const source = new FakeShareSource([
      { value: "Spec draft\nhttps://example.com/spec", shareType: "text", mimeType: "text/plain" },
    ]);

    const read = await readIncomingShare(source, createId);

    expect(read).toEqual({
      share: { id: "share-1", text: "Spec draft\nhttps://example.com/spec", files: [] },
      filesUnreadable: false,
    });
    expect(source.resolveCalls).toBe(0);
  });

  it("names the same link once when iOS lists it as both a link and text", async () => {
    const source = new FakeShareSource([
      { value: "https://example.com/spec", shareType: "url", mimeType: "text/html" },
      { value: "https://example.com/spec", shareType: "text", mimeType: "text/plain" },
    ]);

    const read = await readIncomingShare(source, createId);

    expect(read.share?.text).toBe("https://example.com/spec");
  });

  it("keeps the text and reports the files when they cannot be copied", async () => {
    const source = new FakeShareSource(
      [
        { value: "Look at this", shareType: "text", mimeType: "text/plain" },
        { value: "file:///group/deck.pptx", shareType: "file", mimeType: "application/zip" },
      ],
      async () => {
        throw new Error("resolution failed");
      },
    );

    const read = await readIncomingShare(source, createId);

    expect(read).toEqual({
      share: { id: "share-1", text: "Look at this", files: [] },
      filesUnreadable: true,
    });
    expect(source.cleared).toBe(1);
  });

  it("offers nothing when nothing was shared", async () => {
    const source = new FakeShareSource([]);

    expect(await readIncomingShare(source, createId)).toEqual({
      share: null,
      filesUnreadable: false,
    });
  });
});

describe("normalizeLocalFileUri", () => {
  it("turns a java.io.File URI into a file URL and leaves file URLs alone", () => {
    expect(normalizeLocalFileUri("file:/data/cache/a.pdf")).toBe("file:///data/cache/a.pdf");
    expect(normalizeLocalFileUri("file:///var/group/a.pdf")).toBe("file:///var/group/a.pdf");
  });
});

describe("redirectShareIntakePath", () => {
  it("opens the root route on a cold start and stays put on a warm one", () => {
    expect(redirectShareIntakePath({ path: "paseo://expo-sharing", initial: true })).toBe("/");
    expect(redirectShareIntakePath({ path: "paseo://expo-sharing", initial: false })).toBeNull();
  });

  it("passes every other URL through", () => {
    const path = "paseo://h/server-1/agent/agent-1";
    expect(redirectShareIntakePath({ path, initial: true })).toBe(path);
    expect(redirectShareIntakePath({ path: "paseo://expo-sharing-other", initial: false })).toBe(
      "paseo://expo-sharing-other",
    );
  });
});

describe("describeIncomingShare", () => {
  it("names the files, or the first line of text when there are none", () => {
    expect(
      describeIncomingShare({
        id: "s",
        text: "ignored",
        files: [
          { uri: "file:///a", name: "deck.pptx", mimeType: "application/zip" },
          { uri: "file:///b", name: "notes.pdf", mimeType: "application/pdf" },
        ],
      }),
    ).toBe("deck.pptx, notes.pdf");
    expect(describeIncomingShare({ id: "s", text: "Title\nhttps://x.dev", files: [] })).toBe(
      "Title",
    );
  });
});

describe("coalesceRuns", () => {
  it("runs once more for requests that arrive mid-run, not once per request", async () => {
    let runs = 0;
    let finishRun: () => void = () => {};
    const run = coalesceRuns(
      () =>
        new Promise<void>((resolve) => {
          runs += 1;
          finishRun = resolve;
        }),
    );

    const first = run();
    void run();
    void run();
    expect(runs).toBe(1);

    finishRun();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);

    finishRun();
    await first;
    expect(runs).toBe(2);
  });
});
