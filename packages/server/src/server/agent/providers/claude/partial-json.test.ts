import { describe, expect, it } from "vitest";

import { parsePartialJsonObject } from "./partial-json.js";

describe("parsePartialJsonObject", () => {
  it("parses complete objects", () => {
    expect(
      parsePartialJsonObject("{\"command\":\"pwd\",\"cwd\":\"/tmp/repo\"}")
    ).toEqual({
      value: {
        command: "pwd",
        cwd: "/tmp/repo",
      },
      complete: true,
    });
  });

  it("keeps partial string values without field-specific logic", () => {
    expect(parsePartialJsonObject("{\"command\":\"echo ")).toEqual({
      value: {
        command: "echo ",
      },
      complete: false,
    });
  });

  it("returns parsed prefix fields from incomplete objects", () => {
    expect(
      parsePartialJsonObject(
        "{\"file_path\":\"src/message.tsx\",\"old_string\":\"before"
      )
    ).toEqual({
      value: {
        file_path: "src/message.tsx",
        old_string: "before",
      },
      complete: false,
    });
  });

  it("parses nested partial values generically", () => {
    expect(
      parsePartialJsonObject(
        "{\"payload\":{\"path\":\"src/index.ts\",\"content\":\"hello"
      )
    ).toEqual({
      value: {
        payload: {
          path: "src/index.ts",
          content: "hello",
        },
      },
      complete: false,
    });
  });

  it("returns null for non-object payloads", () => {
    expect(parsePartialJsonObject("\"text\"")).toBeNull();
  });
});
