import { describe, expect, it } from "vitest";
import { FILE_UPLOAD_MAX_BYTES } from "@/attachments/upload-limit";
import { TerminalFilePasteQueue, type TerminalFile, type TerminalFilePasteTarget } from "./index";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function file(fileName: string, bytes: number[] = [1, 2, 3]): TerminalFile {
  return { fileName, mimeType: "image/png", bytes: new Uint8Array(bytes) };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeHost implements TerminalFilePasteTarget {
  readonly uploads: TerminalFile[] = [];
  readonly pasted: string[] = [];
  private readonly results = new Map<string, Promise<string>>();

  holdUpload(fileName: string): ReturnType<typeof deferred<string>> {
    const result = deferred<string>();
    this.results.set(fileName, result.promise);
    return result;
  }

  async upload(input: TerminalFile): Promise<string> {
    this.uploads.push(input);
    return this.results.get(input.fileName) ?? `/host/uploads/${input.fileName}`;
  }

  paste(text: string): void {
    this.pasted.push(text);
  }
}

function createQueue() {
  const events = { uploading: [] as boolean[], uploaded: 0, failures: [] as string[] };
  const queue = new TerminalFilePasteQueue({
    onUploadingChange: (uploading) => {
      events.uploading.push(uploading);
    },
    onUploaded: () => {
      events.uploaded += 1;
    },
    onFailure: (error) => {
      events.failures.push(error instanceof Error ? error.message : String(error));
    },
  });
  return { queue, events, host: new FakeHost() };
}

describe("terminal file paste queue", () => {
  it("pastes each uploaded host path in gesture order", async () => {
    const { queue, host, events } = createQueue();
    const firstRead = deferred<TerminalFile | null>();
    const firstUpload = host.holdUpload("a.png");

    queue.add(firstRead.promise, host);
    queue.add(Promise.resolve(file("b.png")), host);
    await settle();
    expect(host.uploads).toEqual([]);

    firstRead.resolve(file("a.png"));
    await settle();
    expect(host.uploads.map((upload) => upload.fileName)).toEqual(["a.png"]);

    firstUpload.resolve("/host/uploads/a.png");
    await settle();
    expect(host.pasted).toEqual(["'/host/uploads/a.png'", "'/host/uploads/b.png'"]);
    expect(events).toEqual({ uploading: [true, false, true, false], uploaded: 2, failures: [] });
  });

  it("quotes Windows host paths for the host shell", async () => {
    const { queue, host } = createQueue();
    host.holdUpload("shot.png").resolve("C:\\Users\\Jo Doe\\.paseo\\uploads\\upload_1\\shot.png");

    queue.add(Promise.resolve(file("shot.png")), host);
    await settle();

    expect(host.pasted).toEqual(['"C:\\Users\\Jo Doe\\.paseo\\uploads\\upload_1\\shot.png"']);
  });

  it("uploads under a file name that needs no shell quoting", async () => {
    const { queue, host } = createQueue();

    queue.add(Promise.resolve(file("Screen Shot #1 (it's $HOME).png")), host);
    await settle();

    expect(host.uploads.map((upload) => upload.fileName)).toEqual([
      "Screen_Shot__1__it_s__HOME_.png",
    ]);
  });

  it("does nothing for a gesture that carried no file", async () => {
    const { queue, host, events } = createQueue();

    queue.add(Promise.resolve(null), host);
    await settle();

    expect(host.uploads).toEqual([]);
    expect(host.pasted).toEqual([]);
    expect(events).toEqual({ uploading: [], uploaded: 0, failures: [] });
  });

  it("reports a failed upload and keeps pasting later files", async () => {
    const { queue, host, events } = createQueue();
    host.holdUpload("a.png").reject(new Error("disk full"));

    queue.add(Promise.resolve(file("a.png")), host);
    queue.add(Promise.resolve(file("b.png")), host);
    await settle();

    expect(events.failures).toEqual(["disk full"]);
    expect(events.uploaded).toBe(1);
    expect(host.pasted).toEqual(["'/host/uploads/b.png'"]);
  });

  it("reports unreadable and oversized files without uploading them", async () => {
    const { queue, host, events } = createQueue();
    const oversized = {
      ...file("big.png"),
      bytes: new Uint8Array(FILE_UPLOAD_MAX_BYTES + 1),
    };

    queue.add(Promise.reject(new Error("unreadable")), host);
    queue.add(Promise.resolve(oversized), host);
    await settle();

    expect(events.failures).toEqual(["unreadable", "big.png exceeds the upload limit"]);
    expect(host.uploads).toEqual([]);
  });

  it("never pastes the path of an upload cancelled mid-flight", async () => {
    const { queue, host, events } = createQueue();
    const upload = host.holdUpload("a.png");

    queue.add(Promise.resolve(file("a.png")), host);
    queue.add(Promise.resolve(file("b.png")), host);
    await settle();
    expect(queue.cancel()).toBe(true);
    expect(events.uploading).toEqual([true, false]);

    upload.resolve("/host/uploads/a.png");
    await settle();
    expect(host.pasted).toEqual([]);
    expect(host.uploads.map((entry) => entry.fileName)).toEqual(["a.png"]);
    expect(events.failures).toEqual([]);
    expect(events.uploaded).toBe(0);
  });

  it("does not hold new pastes behind a cancelled upload that never settles", async () => {
    const { queue, host, events } = createQueue();
    host.holdUpload("stuck.png");

    queue.add(Promise.resolve(file("stuck.png")), host);
    await settle();
    queue.cancel();
    queue.add(Promise.resolve(file("next.png")), host);
    await settle();

    expect(host.pasted).toEqual(["'/host/uploads/next.png'"]);
    expect(events.uploading).toEqual([true, false, true, false]);
    expect(queue.cancel()).toBe(false);
  });
});
