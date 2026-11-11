import { describe, expect, it } from "vitest";
import { FilePathCopyModel, type FilePathClipboard, type FilePathCopyStatus } from "./copy-model";

/** A clipboard that completes writes only when the test confirms or denies them. */
class MemoryClipboard implements FilePathClipboard {
  contents = "unchanged clipboard";
  writes: string[] = [];
  succeed!: () => void;
  deny!: () => void;

  writeText(text: string): Promise<void> {
    this.writes.push(text);
    return new Promise<void>((resolve, reject) => {
      this.succeed = () => {
        this.contents = text;
        resolve();
      };
      this.deny = () => reject(new Error("Clipboard access denied"));
    });
  }
}

function setup() {
  const clipboard = new MemoryClipboard();
  const model = new FilePathCopyModel(clipboard);
  const feedback: FilePathCopyStatus[] = [];
  model.subscribe(() => feedback.push(model.getSnapshot()));
  return { clipboard, model, feedback };
}

describe("file path copy", () => {
  it("keeps a delayed write pending, suppresses duplicates, and confirms the actual copied path", async () => {
    const { clipboard, model, feedback } = setup();
    const writing = model.copy("/repo/report.md");
    expect(model.getSnapshot()).toBe("pending");
    expect(clipboard.contents).toBe("unchanged clipboard");
    await model.copy("/repo/duplicate.md");
    expect(clipboard.writes).toEqual(["/repo/report.md"]);
    clipboard.succeed();
    await writing;
    expect(clipboard.contents).toBe("/repo/report.md");
    expect(feedback).toEqual(["pending", "copied"]);
  });

  it("keeps rejection visible with unchanged contents and no success feedback, then permits retry", async () => {
    const { clipboard, model, feedback } = setup();
    const writing = model.copy("~/report.md");
    clipboard.deny();
    await writing;
    expect(model.getSnapshot()).toBe("error");
    expect(clipboard.contents).toBe("unchanged clipboard");
    expect(feedback).toEqual(["pending", "error"]);
    const retry = model.copy("~/report.md");
    expect(model.getSnapshot()).toBe("pending");
    clipboard.succeed();
    await retry;
    expect(clipboard.contents).toBe("~/report.md");
    expect(feedback).toEqual(["pending", "error", "pending", "copied"]);
  });

  it("lets the reader dismiss an error without reporting a successful write", async () => {
    const { clipboard, model, feedback } = setup();
    const writing = model.copy("report.md");
    clipboard.deny();
    await writing;
    model.dismissError();
    expect(model.getSnapshot()).toBe("idle");
    expect(clipboard.contents).toBe("unchanged clipboard");
    expect(feedback).toEqual(["pending", "error", "idle"]);
    model.dismissError();
    expect(feedback).toEqual(["pending", "error", "idle"]);
  });
});
