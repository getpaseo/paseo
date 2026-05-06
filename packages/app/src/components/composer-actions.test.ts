import { describe, expect, it } from "vitest";
import type { AgentAttachment, GitHubSearchItem } from "@server/shared/messages";
import type {
  AttachmentMetadata,
  ComposerAttachment,
  UserComposerAttachment,
  WorkspaceComposerAttachment,
} from "@/attachments/types";
import type { StreamItem } from "@/types/stream";
import {
  cancelComposerAgent,
  dispatchComposerAgentMessage,
  editQueuedComposerMessage,
  findGithubItemByOption,
  isAttachmentSelectedForGithubItem,
  openComposerAttachment,
  pickAndPersistImages,
  queueComposerMessage,
  removeComposerAttachmentAtIndex,
  sendQueuedComposerMessageNow,
  toggleGithubAttachment,
  type AgentStreamWriter,
  type AttachmentPersister,
  type ComposerCancelClient,
  type ComposerSendClient,
  type QueueWriter,
  type QueuedComposerMessage,
} from "./composer-actions";

const imageMetadata: AttachmentMetadata = {
  id: "img-1",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "img-1",
  fileName: "img-1.png",
  byteSize: 42,
  createdAt: 1,
};

const issueItem: GitHubSearchItem = {
  kind: "issue",
  number: 101,
  title: "Fix composer attachments",
  url: "https://github.com/acme/paseo/issues/101",
  state: "open",
  body: "Issue body",
  labels: ["composer"],
  baseRefName: null,
  headRefName: null,
};

const prItem: GitHubSearchItem = {
  kind: "pr",
  number: 202,
  title: "Refactor composer attachments",
  url: "https://github.com/acme/paseo/pull/202",
  state: "open",
  body: "PR body",
  labels: ["composer"],
  baseRefName: "main",
  headRefName: "composer-attachments",
};

function imageWithId(id: string): AttachmentMetadata {
  return { ...imageMetadata, id, storageKey: id, fileName: `${id}.png` };
}

function reviewWorkspaceAttachment(body: string): WorkspaceComposerAttachment {
  const attachment: Extract<AgentAttachment, { type: "review" }> = {
    type: "review",
    mimeType: "application/paseo-review",
    cwd: "/repo",
    mode: "uncommitted",
    baseRef: null,
    comments: [
      {
        filePath: "src/example.ts",
        side: "new",
        lineNumber: 41,
        body,
        context: {
          hunkHeader: "@@ -40,2 +40,2 @@",
          targetLine: {
            oldLineNumber: null,
            newLineNumber: 41,
            type: "add",
            content: "const value = newValue;",
          },
          lines: [
            {
              oldLineNumber: null,
              newLineNumber: 41,
              type: "add",
              content: "const value = newValue;",
            },
          ],
        },
      },
    ],
  };
  return {
    kind: "review",
    reviewDraftKey: `review:${body}`,
    commentCount: 1,
    attachment,
  };
}

function browserElementWorkspaceAttachment(): Extract<
  WorkspaceComposerAttachment,
  { kind: "browser_element" }
> {
  return {
    kind: "browser_element",
    attachment: {
      url: "https://example.com/page",
      selector: "button.primary",
      tag: "button",
      text: "Save",
      outerHTML: '<button class="primary">Save</button>',
      computedStyles: { display: "flex" },
      boundingRect: { x: 1, y: 2, width: 80, height: 32 },
      reactSource: null,
      parentChain: ["form.settings"],
      children: [],
      formatted: '<browser-element url="https://example.com/page">button.primary</browser-element>',
    },
  };
}

function createFakePersister(): AttachmentPersister & {
  blobCalls: Array<{ blob: Blob; mimeType: string; fileName: string | null }>;
  fileUriCalls: Array<{ uri: string; mimeType: string; fileName: string | null }>;
  deletedBatches: AttachmentMetadata[][];
} {
  const blobCalls: Array<{ blob: Blob; mimeType: string; fileName: string | null }> = [];
  const fileUriCalls: Array<{ uri: string; mimeType: string; fileName: string | null }> = [];
  const deletedBatches: AttachmentMetadata[][] = [];
  return {
    blobCalls,
    fileUriCalls,
    deletedBatches,
    persistFromBlob: async ({ blob, mimeType, fileName }) => {
      blobCalls.push({ blob, mimeType, fileName });
      return { ...imageMetadata, id: `blob-${blobCalls.length}` };
    },
    persistFromFileUri: async ({ uri, mimeType, fileName }) => {
      fileUriCalls.push({ uri, mimeType, fileName });
      return { ...imageMetadata, id: `uri-${fileUriCalls.length}` };
    },
    deleteAttachments: (metadata) => {
      deletedBatches.push(metadata);
    },
  };
}

interface FakeSendCall {
  agentId: string;
  text: string;
  options: {
    messageId: string;
    images: Array<{ data: string; mimeType: string }>;
    attachments: AgentAttachment[];
  };
}

function createFakeSendClient(
  options: { rejection?: Error } = {},
): ComposerSendClient & { calls: FakeSendCall[] } {
  const calls: FakeSendCall[] = [];
  return {
    calls,
    sendAgentMessage: async (agentId, text, opts) => {
      calls.push({ agentId, text, options: opts });
      if (options.rejection) {
        throw options.rejection;
      }
    },
  };
}

interface FakeStream extends AgentStreamWriter {
  head: Map<string, StreamItem[]>;
  tail: Map<string, StreamItem[]>;
}

function createFakeStream(initialHead: Map<string, StreamItem[]> = new Map()): FakeStream {
  const fake: FakeStream = {
    head: new Map(initialHead),
    tail: new Map(),
    getHead: (agentId) => fake.head.get(agentId),
    setHead: (updater) => {
      fake.head = updater(fake.head);
    },
    setTail: (updater) => {
      fake.tail = updater(fake.tail);
    },
  };
  return fake;
}

function createFakeQueue(
  initial: Map<string, QueuedComposerMessage[]> = new Map(),
): QueueWriter & { state: Map<string, QueuedComposerMessage[]> } {
  const fake: QueueWriter & { state: Map<string, QueuedComposerMessage[]> } = {
    state: new Map(initial),
    read: (agentId) => fake.state.get(agentId) ?? [],
    write: (updater) => {
      fake.state = updater(fake.state);
    },
  };
  return fake;
}

const passthroughEncodeImages = async (images: AttachmentMetadata[]) =>
  images.map((image) => ({ data: image.id, mimeType: image.mimeType }));

describe("cancelComposerAgent", () => {
  function baseInput(): {
    client: ComposerCancelClient & { canceledIds: string[] };
    agentId: string;
    isAgentRunning: boolean;
    isCancellingAgent: boolean;
    isConnected: boolean;
  } {
    const canceledIds: string[] = [];
    return {
      client: {
        canceledIds,
        cancelAgent: async (id) => {
          canceledIds.push(id);
        },
      },
      agentId: "agent",
      isAgentRunning: true,
      isCancellingAgent: false,
      isConnected: true,
    };
  }

  it("issues a cancel and reports true when the agent is running, connected, and not already canceling", () => {
    const input = baseInput();
    const result = cancelComposerAgent(input);
    expect(result).toBe(true);
    expect(input.client.canceledIds).toEqual(["agent"]);
  });

  it("does nothing when the agent is not running", () => {
    const input = baseInput();
    const result = cancelComposerAgent({ ...input, isAgentRunning: false });
    expect(result).toBe(false);
    expect(input.client.canceledIds).toEqual([]);
  });

  it("does nothing when the agent is already being canceled", () => {
    const input = baseInput();
    const result = cancelComposerAgent({ ...input, isCancellingAgent: true });
    expect(result).toBe(false);
    expect(input.client.canceledIds).toEqual([]);
  });

  it("does nothing when disconnected or the client is null", () => {
    const input = baseInput();
    expect(cancelComposerAgent({ ...input, isConnected: false })).toBe(false);
    expect(cancelComposerAgent({ ...input, client: null })).toBe(false);
    expect(input.client.canceledIds).toEqual([]);
  });
});

describe("pickAndPersistImages", () => {
  it("returns [] when the picker yields nothing", async () => {
    const persister = createFakePersister();
    const result = await pickAndPersistImages({
      pickImages: async () => null,
      persister,
    });
    expect(result).toEqual([]);
    expect(persister.blobCalls).toEqual([]);
    expect(persister.fileUriCalls).toEqual([]);
  });

  it("persists blob sources via persistFromBlob with the picked mime type and file name", async () => {
    const persister = createFakePersister();
    const blob = new Blob(["image"]);
    const result = await pickAndPersistImages({
      pickImages: async () => [
        { source: { kind: "blob", blob }, mimeType: "image/png", fileName: "img-1.png" },
      ],
      persister,
    });
    expect(persister.blobCalls).toEqual([{ blob, mimeType: "image/png", fileName: "img-1.png" }]);
    expect(result.map((m) => m.id)).toEqual(["blob-1"]);
  });

  it("persists file_uri sources via persistFromFileUri", async () => {
    const persister = createFakePersister();
    const result = await pickAndPersistImages({
      pickImages: async () => [
        { source: { kind: "file_uri", uri: "/tmp/x.jpg" }, mimeType: null, fileName: null },
      ],
      persister,
    });
    expect(persister.fileUriCalls).toEqual([
      { uri: "/tmp/x.jpg", mimeType: "image/jpeg", fileName: null },
    ]);
    expect(result).toHaveLength(1);
  });
});

describe("dispatchComposerAgentMessage", () => {
  it("sends text + image data + structured attachments and appends user_message to the tail when head is empty", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    const image = imageWithId("img-2");

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "send attachments",
      attachments: [
        { kind: "image", metadata: image },
        { kind: "github_pr", item: prItem },
      ],
      encodeImages: passthroughEncodeImages,
      stream,
    });

    expect(client.calls).toHaveLength(1);
    const [call] = client.calls;
    expect(call.agentId).toBe("agent");
    expect(call.text).toBe("send attachments");
    expect(call.options.images).toEqual([{ data: image.id, mimeType: image.mimeType }]);
    expect(call.options.attachments).toEqual([
      {
        type: "github_pr",
        mimeType: "application/github-pr",
        number: 202,
        title: "Refactor composer attachments",
        url: "https://github.com/acme/paseo/pull/202",
        body: "PR body",
        baseRefName: "main",
        headRefName: "composer-attachments",
      },
    ]);

    expect(stream.head.get("agent")).toBeUndefined();
    const tail = stream.tail.get("agent");
    expect(tail).toHaveLength(1);
    const userMessage = tail?.[0] as Extract<StreamItem, { kind: "user_message" }>;
    expect(userMessage.kind).toBe("user_message");
    expect(userMessage.text).toBe("send attachments");
    expect(userMessage.images).toEqual([image]);
    expect(userMessage.attachments).toEqual(call.options.attachments);
    expect(userMessage.id).toBe(call.options.messageId);
  });

  it("appends to the existing head when one is present", async () => {
    const existingItem: StreamItem = {
      kind: "user_message",
      id: "prior",
      text: "prior",
      timestamp: new Date(0),
    };
    const stream = createFakeStream(new Map([["agent", [existingItem]]]));
    const client = createFakeSendClient();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "next message",
      attachments: [],
      encodeImages: passthroughEncodeImages,
      stream,
    });

    expect(stream.head.get("agent")).toHaveLength(2);
    expect(stream.tail.get("agent")).toBeUndefined();
  });

  it("submits empty wire arrays when no attachments are provided", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "plain message",
      attachments: [],
      encodeImages: passthroughEncodeImages,
      stream,
    });

    expect(client.calls[0]?.options).toMatchObject({
      images: [],
      attachments: [],
    });
  });

  it("serializes workspace review attachments through the structured attachment path", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    const review = reviewWorkspaceAttachment("Please simplify this.");

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "review this",
      attachments: [review],
      encodeImages: passthroughEncodeImages,
      stream,
    });

    expect(client.calls[0]?.options.attachments).toEqual([review.attachment]);
    expect(client.calls[0]?.options.images).toEqual([]);
  });

  it("serializes browser_element workspace attachments as text attachments at the wire boundary", async () => {
    const client = createFakeSendClient();
    const stream = createFakeStream();
    const browserElement = browserElementWorkspaceAttachment();

    await dispatchComposerAgentMessage({
      client,
      agentId: "agent",
      text: "inspect element",
      attachments: [browserElement],
      encodeImages: passthroughEncodeImages,
      stream,
    });

    expect(client.calls[0]?.options.attachments).toEqual([
      {
        type: "text",
        mimeType: "text/plain",
        title: "Browser element · button",
        text: browserElement.attachment.formatted,
      },
    ]);
  });
});

describe("queueComposerMessage", () => {
  it("queues a trimmed message under the agent id and returns the new entry", () => {
    const queue = createFakeQueue();
    const result = queueComposerMessage({
      agentId: "agent",
      text: "  draft  ",
      attachments: [],
      queue,
    });

    expect(result.queued?.text).toBe("draft");
    expect(queue.state.get("agent")).toEqual([
      { id: result.queued?.id, text: "draft", attachments: [] },
    ]);
  });

  it("does not queue an empty message with no attachments", () => {
    const queue = createFakeQueue();
    const result = queueComposerMessage({
      agentId: "agent",
      text: "   ",
      attachments: [],
      queue,
    });
    expect(result.queued).toBeNull();
    expect(queue.state.get("agent")).toBeUndefined();
  });

  it("captures workspace review attachments at queue time alongside user attachments", () => {
    const queue = createFakeQueue();
    const review = reviewWorkspaceAttachment("Initial queued review.");
    const image = imageWithId("img-queue");
    queueComposerMessage({
      agentId: "agent",
      text: "queue this",
      attachments: [{ kind: "image", metadata: image }, review],
      queue,
    });

    expect(queue.state.get("agent")?.[0]?.attachments).toEqual([
      { kind: "image", metadata: image },
      review,
    ]);
  });
});

describe("editQueuedComposerMessage", () => {
  it("returns null and leaves the queue untouched when the message id is missing", () => {
    const queue = createFakeQueue(
      new Map([["agent", [{ id: "other", text: "other", attachments: [] }]]]),
    );
    const result = editQueuedComposerMessage({ agentId: "agent", messageId: "missing", queue });
    expect(result).toBeNull();
    expect(queue.state.get("agent")).toHaveLength(1);
  });

  it("returns the text and only user attachments, removing the queued entry", () => {
    const review = reviewWorkspaceAttachment("Queued snapshot.");
    const image = imageWithId("img-queued-edit");
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            {
              id: "msg-1",
              text: "queued draft",
              attachments: [{ kind: "image", metadata: image }, review],
            },
          ],
        ],
      ]),
    );

    const result = editQueuedComposerMessage({ agentId: "agent", messageId: "msg-1", queue });
    expect(result).toEqual({
      text: "queued draft",
      attachments: [{ kind: "image", metadata: image }],
    });
    expect(queue.state.get("agent")).toEqual([]);
  });
});

describe("sendQueuedComposerMessageNow", () => {
  it("returns missing without submitting when the message id is gone", async () => {
    const queue = createFakeQueue();
    const submitted: Array<{ text: string; attachments: ComposerAttachment[] }> = [];
    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "msg-1",
      queue,
      submitMessage: async (input) => {
        submitted.push(input);
      },
    });
    expect(result).toEqual({ status: "missing" });
    expect(submitted).toEqual([]);
  });

  it("removes the queued entry and submits its text + attachments", async () => {
    const review = reviewWorkspaceAttachment("Queued for send.");
    const queue = createFakeQueue(
      new Map([["agent", [{ id: "msg-1", text: "send me", attachments: [review] }]]]),
    );
    const submitted: Array<{ text: string; attachments: ComposerAttachment[] }> = [];
    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "msg-1",
      queue,
      submitMessage: async (input) => {
        submitted.push(input);
      },
    });
    expect(result).toEqual({ status: "submitted" });
    expect(queue.state.get("agent")).toEqual([]);
    expect(submitted).toEqual([{ text: "send me", attachments: [review] }]);
  });

  it("restores the queued entry to the front and surfaces the error message on failure", async () => {
    const queue = createFakeQueue(
      new Map([
        [
          "agent",
          [
            { id: "msg-1", text: "first", attachments: [] },
            { id: "msg-2", text: "second", attachments: [] },
          ],
        ],
      ]),
    );
    const result = await sendQueuedComposerMessageNow({
      agentId: "agent",
      messageId: "msg-1",
      queue,
      submitMessage: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toEqual({ status: "failed", errorMessage: "network down" });
    const state = queue.state.get("agent");
    expect(state?.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });
});

describe("removeComposerAttachmentAtIndex", () => {
  it("removes an image attachment and asks the persister to delete the underlying metadata", () => {
    const image = imageWithId("img-remove");
    const persister = createFakePersister();
    const next = removeComposerAttachmentAtIndex({
      attachments: [{ kind: "image", metadata: image }] satisfies UserComposerAttachment[],
      index: 0,
      deleteAttachments: persister.deleteAttachments,
    });
    expect(next).toEqual([]);
    expect(persister.deletedBatches).toEqual([[image]]);
  });

  it("removes a github attachment without scheduling any storage deletes", () => {
    const persister = createFakePersister();
    const next = removeComposerAttachmentAtIndex({
      attachments: [
        { kind: "github_issue", item: issueItem },
        { kind: "github_pr", item: prItem },
      ] satisfies UserComposerAttachment[],
      index: 0,
      deleteAttachments: persister.deleteAttachments,
    });
    expect(next).toEqual([{ kind: "github_pr", item: prItem }]);
    expect(persister.deletedBatches).toEqual([]);
  });
});

describe("openComposerAttachment", () => {
  it("opens the lightbox for image attachments", () => {
    const image = imageWithId("img-body");
    const lightboxCalls: AttachmentMetadata[] = [];
    const externalUrlCalls: string[] = [];
    openComposerAttachment({
      attachment: { kind: "image", metadata: image },
      setLightboxMetadata: (metadata) => {
        lightboxCalls.push(metadata);
      },
      openWorkspaceAttachment: () => false,
      openExternalUrl: (url) => {
        externalUrlCalls.push(url);
      },
    });
    expect(lightboxCalls).toEqual([image]);
    expect(externalUrlCalls).toEqual([]);
  });

  it("delegates workspace review attachments to the workspace opener", () => {
    const review = reviewWorkspaceAttachment("Open me.");
    const workspaceCalls: ComposerAttachment[] = [];
    openComposerAttachment({
      attachment: review,
      setLightboxMetadata: () => {
        throw new Error("unexpected lightbox call");
      },
      openWorkspaceAttachment: ({ attachment }) => {
        workspaceCalls.push(attachment);
        return true;
      },
      openExternalUrl: () => {
        throw new Error("unexpected external url call");
      },
    });
    expect(workspaceCalls).toEqual([review]);
  });

  it("opens GitHub item URLs through the external url opener", () => {
    const externalUrlCalls: string[] = [];
    openComposerAttachment({
      attachment: { kind: "github_issue", item: issueItem },
      setLightboxMetadata: () => {
        throw new Error("unexpected lightbox call");
      },
      openWorkspaceAttachment: () => false,
      openExternalUrl: (url) => {
        externalUrlCalls.push(url);
      },
    });
    expect(externalUrlCalls).toEqual([issueItem.url]);
  });
});

describe("toggleGithubAttachment", () => {
  it("appends a GitHub issue when not already attached", () => {
    const next = toggleGithubAttachment([], issueItem);
    expect(next).toEqual([{ kind: "github_issue", item: issueItem }]);
  });

  it("appends a GitHub PR when not already attached", () => {
    const next = toggleGithubAttachment([], prItem);
    expect(next).toEqual([{ kind: "github_pr", item: prItem }]);
  });

  it("removes an existing GitHub item with the same kind+number", () => {
    const next = toggleGithubAttachment([{ kind: "github_issue", item: issueItem }], issueItem);
    expect(next).toEqual([]);
  });

  it("does not affect other items with different kind or number", () => {
    const start: UserComposerAttachment[] = [
      { kind: "github_issue", item: issueItem },
      { kind: "github_pr", item: prItem },
    ];
    const otherIssue: GitHubSearchItem = { ...issueItem, number: 999 };
    const next = toggleGithubAttachment(start, otherIssue);
    expect(next).toEqual([
      { kind: "github_issue", item: issueItem },
      { kind: "github_pr", item: prItem },
      { kind: "github_issue", item: otherIssue },
    ]);
  });
});

describe("findGithubItemByOption / isAttachmentSelectedForGithubItem", () => {
  it("locates items via their composite kind:number id", () => {
    expect(findGithubItemByOption([issueItem, prItem], "issue:101")).toBe(issueItem);
    expect(findGithubItemByOption([issueItem, prItem], "pr:202")).toBe(prItem);
    expect(findGithubItemByOption([issueItem], "pr:404")).toBeUndefined();
  });

  it("recognizes when an attachment list already contains a matching GitHub item", () => {
    const attachments: ComposerAttachment[] = [
      { kind: "image", metadata: imageWithId("img-x") },
      { kind: "github_issue", item: issueItem },
      reviewWorkspaceAttachment("ignored"),
    ];
    expect(isAttachmentSelectedForGithubItem(attachments, issueItem)).toBe(true);
    expect(isAttachmentSelectedForGithubItem(attachments, prItem)).toBe(false);
  });
});
