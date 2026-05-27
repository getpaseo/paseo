import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "@/attachments/types";
import {
  createDesktopPreviewUrlResolver,
  type DesktopFileReader,
  type ObjectUrlMinter,
} from "./desktop-preview-url";

class FakeDesktopReader implements DesktopFileReader {
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string>) {}

  async readFileBase64(storageKey: string): Promise<string> {
    this.reads.push(storageKey);
    const base64 = this.files[storageKey];
    if (base64 === undefined) {
      throw new Error(`FakeDesktopReader: no file registered for ${storageKey}`);
    }
    return base64;
  }
}

interface FakeMintedUrl {
  url: string;
  mimeType: string;
  base64: string;
}

class FakeObjectUrls implements ObjectUrlMinter {
  readonly minted: FakeMintedUrl[] = [];
  readonly revoked: string[] = [];
  private nextId = 1;
  private readonly supportsCreate: boolean;

  constructor(options: { supportsCreate?: boolean } = {}) {
    this.supportsCreate = options.supportsCreate ?? true;
  }

  tryCreate(input: { mimeType: string; base64: string }): string | null {
    if (!this.supportsCreate) {
      return null;
    }
    const url = `blob:fake-${this.nextId++}`;
    this.minted.push({ url, ...input });
    return url;
  }

  revoke(url: string): void {
    this.revoked.push(url);
  }
}

function attachment(overrides: Partial<AttachmentMetadata> = {}): AttachmentMetadata {
  return {
    id: "att-1",
    mimeType: "image/png",
    storageType: "desktop-file",
    storageKey: "/tmp/att-1.png",
    fileName: null,
    byteSize: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("desktop preview URLs", () => {
  it("mints an object URL from the desktop file's base64 bytes", async () => {
    const reader = new FakeDesktopReader({ "/tmp/att-1.png": "AAECAw==" });
    const objectUrls = new FakeObjectUrls();
    const resolver = createDesktopPreviewUrlResolver({ reader, objectUrls });

    const url = await resolver.resolve(attachment());

    expect(url).toBe("blob:fake-1");
    expect(reader.reads).toEqual(["/tmp/att-1.png"]);
    expect(objectUrls.minted).toEqual([
      { url: "blob:fake-1", mimeType: "image/png", base64: "AAECAw==" },
    ]);
  });

  it("falls back to a data URL when the host cannot mint object URLs", async () => {
    const reader = new FakeDesktopReader({ "/tmp/att-2.jpg": "AAECAw==" });
    const objectUrls = new FakeObjectUrls({ supportsCreate: false });
    const resolver = createDesktopPreviewUrlResolver({ reader, objectUrls });

    const url = await resolver.resolve(
      attachment({ id: "att-2", mimeType: "image/jpeg", storageKey: "/tmp/att-2.jpg" }),
    );

    expect(url).toBe("data:image/jpeg;base64,AAECAw==");
    expect(objectUrls.revoked).toEqual([]);
  });

  it("revokes only object URLs it minted", async () => {
    const reader = new FakeDesktopReader({ "/tmp/att-3.jpg": "AAECAw==" });
    const objectUrls = new FakeObjectUrls();
    const resolver = createDesktopPreviewUrlResolver({ reader, objectUrls });

    const url = await resolver.resolve(
      attachment({ id: "att-3", mimeType: "image/jpeg", storageKey: "/tmp/att-3.jpg" }),
    );
    await resolver.release({ url });
    await resolver.release({ url: "blob:never-minted" });

    expect(objectUrls.revoked).toEqual([url]);
  });

  it("only revokes a minted URL once across repeated release calls", async () => {
    const reader = new FakeDesktopReader({ "/tmp/att-4.png": "AAECAw==" });
    const objectUrls = new FakeObjectUrls();
    const resolver = createDesktopPreviewUrlResolver({ reader, objectUrls });

    const url = await resolver.resolve(attachment({ id: "att-4", storageKey: "/tmp/att-4.png" }));
    await resolver.release({ url });
    await resolver.release({ url });

    expect(objectUrls.revoked).toEqual([url]);
  });
});
