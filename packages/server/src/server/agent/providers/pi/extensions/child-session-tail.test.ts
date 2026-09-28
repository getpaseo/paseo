import { appendFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { ChildSessionTail } from "./child-session-tail.js";
import { mapPiChildSession } from "./child-session.js";
import { childEntry, createChildSessionFile, inputTexts } from "./child-session-fixture.js";

const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

describe("Pi child session tail", () => {
  test("reads only what was appended since the previous read", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const tail = new ChildSessionTail("child", file);
    expect(inputTexts((await tail.read()).events)).toEqual(["first"]);
    expect(await tail.read()).toEqual({ events: [], bytes: 0, fatal: false });
    appendFileSync(file, childEntry("assistant", "second", T2));
    expect(inputTexts((await tail.read()).events)).toEqual(["second"]);
  });

  test("carries an unterminated line into the next read", async () => {
    const line = childEntry("assistant", "late", T2);
    const file = createChildSessionFile(line.slice(0, 24));
    const tail = new ChildSessionTail("child", file);
    expect((await tail.read()).events).toEqual([]);
    appendFileSync(file, line.slice(24));
    expect(inputTexts((await tail.read()).events)).toEqual(["late"]);
  });

  test("loses and repeats nothing when a message spans the read budget", async () => {
    const file = createChildSessionFile(
      childEntry("user", "a", T1) + childEntry("assistant", "b", T2) + childEntry("user", "c", T3),
    );
    const tail = new ChildSessionTail("child", file);
    const seen: string[] = [];
    for (let index = 0; index < 80; index += 1) {
      const read = await tail.read(16);
      seen.push(...inputTexts(read.events));
      if (read.bytes === 0) break;
    }
    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("reads a settled file in full and caps mapped items per read", async () => {
    const file = createChildSessionFile(
      Array.from({ length: 250 }, (_, index) => childEntry("assistant", `m${index}`, T1)).join(""),
    );
    expect(await mapPiChildSession("child", file)).toHaveLength(200);
  });

  test("treats a replaced file as fatal instead of replaying it", async () => {
    const file = createChildSessionFile(childEntry("user", "first", T1));
    const tail = new ChildSessionTail("child", file);
    await tail.read();
    truncateSync(file, 0);
    expect(await tail.read()).toEqual({ events: [], bytes: 0, fatal: true });
  });

  test("yields nothing for a file that does not exist yet", async () => {
    const tail = new ChildSessionTail("child", join(tmpdir(), "paseo-pi-missing", "child.jsonl"));
    expect(await tail.read()).toEqual({ events: [], bytes: 0, fatal: false });
    expect(await mapPiChildSession("child", "/does-not-exist/pi-child.jsonl")).toEqual([]);
  });
});
