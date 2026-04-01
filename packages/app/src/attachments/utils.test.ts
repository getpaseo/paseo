import { describe, expect, it } from "vitest";
import { pathToFileUri } from "./utils";

describe("pathToFileUri", () => {
  it("converts POSIX absolute paths to file URIs", () => {
    expect(pathToFileUri("/home/user/file.txt")).toBe("file:///home/user/file.txt");
  });

  it("converts Windows drive-letter paths to file URIs", () => {
    expect(pathToFileUri("C:\\Users\\file.txt")).toBe("file:///C:/Users/file.txt");
  });

  it("converts UNC paths to host-based file URIs", () => {
    expect(pathToFileUri("\\\\server\\share\\dir")).toBe("file://server/share/dir");
  });

  it("passes through file URIs unchanged", () => {
    expect(pathToFileUri("file:///already/uri")).toBe("file:///already/uri");
  });

  it("passes through relative paths unchanged", () => {
    expect(pathToFileUri("relative/path")).toBe("relative/path");
  });
});
