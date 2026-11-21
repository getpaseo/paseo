import { describe, expect, test } from "vitest";
import { markedPidsFromPs } from "./leftovers.js";

const ENTRY = "PASEO_PROVIDER_PROCESS=4c1d";

describe("markedPidsFromPs", () => {
  test("matches the marker in a process's environment", () => {
    expect(
      markedPidsFromPs({
        commandLines: "  101 python3 -m http.server 8000\n",
        withEnvironment: `  101 python3 -m http.server 8000 HOME=/Users/me ${ENTRY} PATH=/bin\n`,
        entry: ENTRY,
      }),
    ).toEqual([101]);
  });

  test("ignores the marker passed as a command-line argument", () => {
    expect(
      markedPidsFromPs({
        commandLines: `  102 echo ${ENTRY}\n`,
        withEnvironment: `  102 echo ${ENTRY} HOME=/Users/me\n`,
        entry: ENTRY,
      }),
    ).toEqual([]);
  });

  test("ignores another provider's marker and a value that only starts with it", () => {
    expect(
      markedPidsFromPs({
        commandLines: "  103 node a.js\n  104 node b.js\n",
        withEnvironment: [
          "  103 node a.js PASEO_PROVIDER_PROCESS=9f00",
          `  104 node b.js ${ENTRY}-later`,
        ].join("\n"),
        entry: ENTRY,
      }),
    ).toEqual([]);
  });

  test("skips a process that started between the two listings", () => {
    expect(
      markedPidsFromPs({
        commandLines: "",
        withEnvironment: `  105 sh -c sleep ${ENTRY}\n`,
        entry: ENTRY,
      }),
    ).toEqual([]);
  });
});
