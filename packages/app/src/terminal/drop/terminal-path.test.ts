import { describe, expect, it } from "vitest";
import { prepareDroppedPathsForTerminal, prepareTerminalPath } from "./terminal-path";

describe("terminal path quoting", () => {
  it("prepares POSIX paths with conservative escaping", () => {
    expect(prepareTerminalPath("/tmp/my image.png")).toBe("'/tmp/my image.png'");
    expect(prepareTerminalPath("/tmp/a$(touch bad).png")).toBe("'/tmp/a(touch bad).png'");
    expect(prepareTerminalPath("/tmp/it's.png")).toBe("'/tmp/it\\'s.png'");
  });

  it("prepares Windows paths with space quoting", () => {
    expect(prepareTerminalPath("C:\\Users\\me\\photo.png")).toBe("C:\\Users\\me\\photo.png");
    expect(prepareTerminalPath("C:\\Users\\me\\photo one.png")).toBe(
      '"C:\\Users\\me\\photo one.png"',
    );
    expect(prepareTerminalPath("\\\\server\\share\\photo one.png")).toBe(
      '"\\\\server\\share\\photo one.png"',
    );
  });

  it("joins multiple dropped paths for one terminal input", () => {
    expect(prepareDroppedPathsForTerminal(["/tmp/a.png", "/tmp/b c.png"])).toBe(
      "'/tmp/a.png' '/tmp/b c.png'",
    );
  });
});
