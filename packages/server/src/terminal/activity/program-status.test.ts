import { describe, expect, it } from "vitest";
import { ProgramStatusRecords, parseProgramStatusReport } from "./program-status.js";

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("parseProgramStatusReport — minimal reports", () => {
  it("parses a minimal working report to the root record", () => {
    expect(parseProgramStatusReport("state=working")).toEqual({
      state: "working",
      id: null,
    });
  });

  it("parses a full blocked report", () => {
    const msg = base64("Approve deploy to eu-west (production)?");
    expect(
      parseProgramStatusReport(`state=blocked:kind=permission:id=eu-west:app=deploy:msg=${msg}`),
    ).toEqual({
      state: "blocked",
      id: "eu-west",
      kind: "permission",
      app: "deploy",
      msg: "Approve deploy to eu-west (production)?",
    });
  });

  it("accepts unpadded base64", () => {
    expect(parseProgramStatusReport("state=done:msg=TQ")).toMatchObject({
      state: "done",
      msg: "M",
    });
  });

  it("trims whitespace around keys and values", () => {
    expect(parseProgramStatusReport("  state = working : app = omp  ")).toMatchObject({
      state: "working",
      app: "omp",
      id: null,
    });
  });

  it("keeps the last value when a key repeats", () => {
    expect(parseProgramStatusReport("state=working:state=idle")).toMatchObject({ state: "idle" });
  });

  it("ignores unknown keys", () => {
    expect(parseProgramStatusReport("state=done:halo=there")).toMatchObject({ state: "done" });
  });
});

describe("parseProgramStatusReport — skipped pairs", () => {
  it("skips pairs without '=' but keeps the report", () => {
    expect(parseProgramStatusReport("state=working:oops:app=omp")).toMatchObject({
      state: "working",
      app: "omp",
    });
  });

  it("skips pairs with an empty key but keeps the report", () => {
    expect(parseProgramStatusReport("=junk:state=idle")).toMatchObject({ state: "idle" });
  });

  it("skips pairs with a byte outside the value set but keeps the report", () => {
    const parsed = parseProgramStatusReport("state=working:msg=not valid!");
    expect(parsed).toMatchObject({ state: "working" });
    expect(parsed).not.toHaveProperty("msg");
  });

  it("skips pairs with a non-lowercase key but keeps the report", () => {
    expect(parseProgramStatusReport("State=idle:state=working")).toMatchObject({
      state: "working",
    });
  });
});

describe("parseProgramStatusReport — ignored reports", () => {
  it("ignores a report with no state", () => {
    expect(parseProgramStatusReport("app=omp")).toBeNull();
  });

  it("ignores a report with an unrecognized state", () => {
    expect(parseProgramStatusReport("state=sleeping")).toBeNull();
  });

  it("ignores a state named after an Object.prototype property", () => {
    for (const state of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(parseProgramStatusReport(`state=${state}`)).toBeNull();
    }
  });

  it("ignores a report with an invalid id instead of falling back to root", () => {
    expect(parseProgramStatusReport("state=working:id=a//b")).toBeNull();
  });

  it("ignores a report with an empty id", () => {
    expect(parseProgramStatusReport("state=working:id=")).toBeNull();
  });

  it("ignores a report id deeper than 8 levels", () => {
    expect(parseProgramStatusReport("state=working:id=a/a/a/a/a/a/a/a/a")).toBeNull();
  });

  it("ignores a report id with an oversized segment", () => {
    expect(parseProgramStatusReport(`state=working:id=${"a".repeat(33)}`)).toBeNull();
  });
});

describe("parseProgramStatusReport — scoped and degraded values", () => {
  it("drops kind on non-blocked states", () => {
    const parsed = parseProgramStatusReport("state=working:kind=permission");
    expect(parsed).toMatchObject({ state: "working" });
    expect(parsed).not.toHaveProperty("kind");
  });

  it("treats an unrecognized kind as absent", () => {
    const parsed = parseProgramStatusReport("state=blocked:kind=someday");
    expect(parsed).toMatchObject({ state: "blocked" });
    expect(parsed).not.toHaveProperty("kind");
  });

  it("treats a kind named after an Object.prototype property as absent", () => {
    for (const kind of ["constructor", "toString", "__proto__"]) {
      const parsed = parseProgramStatusReport(`state=blocked:kind=${kind}`);
      expect(parsed).toMatchObject({ state: "blocked" });
      expect(parsed).not.toHaveProperty("kind");
    }
  });

  it("keeps progress on working", () => {
    expect(parseProgramStatusReport("state=working:progress=40")).toMatchObject({ progress: 40 });
  });

  it("treats out-of-range and non-numeric progress as absent", () => {
    const overRange = parseProgramStatusReport("state=working:progress=101");
    expect(overRange).toMatchObject({ state: "working" });
    expect(overRange).not.toHaveProperty("progress");
    const nonNumeric = parseProgramStatusReport("state=working:progress=lots");
    expect(nonNumeric).toMatchObject({ state: "working" });
    expect(nonNumeric).not.toHaveProperty("progress");
  });

  it("drops progress on states that cannot carry it", () => {
    const parsed = parseProgramStatusReport("state=done:progress=40");
    expect(parsed).toMatchObject({ state: "done" });
    expect(parsed).not.toHaveProperty("progress");
  });

  it("treats an overlong app as absent but keeps the report", () => {
    const parsed = parseProgramStatusReport(`state=working:app=${"a".repeat(33)}`);
    expect(parsed).toMatchObject({ state: "working" });
    expect(parsed).not.toHaveProperty("app");
  });

  it("accepts a nested id path", () => {
    expect(parseProgramStatusReport("state=blocked:id=build/test:kind=question")).toMatchObject({
      state: "blocked",
      id: "build/test",
      kind: "question",
    });
  });
});

describe("parseProgramStatusReport — discarded reports", () => {
  it("discards a report whose base64 does not decode", () => {
    expect(parseProgramStatusReport("state=done:msg=_")).toBeNull();
  });

  it("discards a report with an undecodable base64 length", () => {
    expect(parseProgramStatusReport("state=done:msg=abcde")).toBeNull();
  });

  it("discards a report with misplaced base64 padding", () => {
    expect(parseProgramStatusReport("state=done:msg=ab=c")).toBeNull();
  });

  it("discards a report whose decoded text holds a newline", () => {
    const msg = base64(`hi${String.fromCharCode(10)}there`);
    expect(parseProgramStatusReport(`state=done:msg=${msg}`)).toBeNull();
  });

  it("discards a report whose decoded text holds DEL", () => {
    const msg = base64(`hi${String.fromCharCode(127)}there`);
    expect(parseProgramStatusReport(`state=done:msg=${msg}`)).toBeNull();
  });

  it("discards a report whose bytes are not valid UTF-8", () => {
    const msg = Buffer.from([0xff, 0xfe]).toString("base64");
    expect(parseProgramStatusReport(`state=done:msg=${msg}`)).toBeNull();
  });

  it("discards a report with an oversized title encoding", () => {
    expect(parseProgramStatusReport(`state=done:title=${"a".repeat(257)}`)).toBeNull();
  });

  it("discards a report with an oversized msg encoding", () => {
    expect(parseProgramStatusReport(`state=done:msg=${"a".repeat(2733)}`)).toBeNull();
  });

  it("discards a report whose decoded msg exceeds the byte cap", () => {
    // 2049 ASCII bytes decode from 2732 encoded bytes: both caps in play.
    const msg = Buffer.from("a".repeat(2049), "utf8").toString("base64");
    expect(parseProgramStatusReport(`state=done:msg=${msg}`)).toBeNull();
  });

  it("discards an overlong sequence", () => {
    expect(parseProgramStatusReport(`state=working:app=${"a".repeat(4090)}`)).toBeNull();
  });

  it("discards a report with an overlong key", () => {
    expect(parseProgramStatusReport(`${"a".repeat(17)}=x:state=idle`)).toBeNull();
  });

  it("applies nothing from a discarded report", () => {
    const records = new ProgramStatusRecords();
    const parsed = parseProgramStatusReport("state=working:id=x:msg=_");
    expect(parsed).toBeNull();
    expect(records.resolve()).toBeNull();
    expect(records.size).toBe(0);
  });
});

describe("ProgramStatusRecords — apply and replace", () => {
  it("starts empty with a null aggregate", () => {
    const records = new ProgramStatusRecords();

    expect(records.size).toBe(0);
    expect(records.resolve()).toBeNull();
  });

  it("stores a root report and resolves it", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "working", id: null });

    expect(records.resolve()).toBe("working");
    expect(records.get(null)).toMatchObject({ state: "working" });
  });

  it("replaces a record completely instead of merging", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "working", id: null, app: "omp", progress: 10 });
    records.apply({ state: "done", id: null });

    expect(records.get(null)).toEqual({ state: "done", id: null });
    expect(records.resolve()).toBe("done");
  });

  it("keeps per-id records side by side", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "idle", id: null });
    records.apply({ state: "working", id: "us-east" });
    records.apply({ state: "blocked", id: "eu-west", kind: "permission" });

    expect(records.size).toBe(3);
    expect(records.resolve()).toBe("blocked");
  });

  it("removes a subtree on clear but keeps siblings and root", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "idle", id: null });
    records.apply({ state: "working", id: "x" });
    records.apply({ state: "working", id: "x/a" });
    records.apply({ state: "working", id: "xyz" });
    records.apply({ state: "working", id: "y" });

    records.apply({ state: "clear", id: "x" });

    expect(records.get("x")).toBeUndefined();
    expect(records.get("x/a")).toBeUndefined();
    expect(records.get("xyz")).toMatchObject({ state: "working" });
    expect(records.get("y")).toMatchObject({ state: "working" });
    expect(records.get(null)).toMatchObject({ state: "idle" });
  });

  it("removes every record on clear without id", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "working", id: null });
    records.apply({ state: "blocked", id: "x" });

    records.apply({ state: "clear", id: null });

    expect(records.size).toBe(0);
    expect(records.resolve()).toBeNull();
  });

  it("evicts the least-recently-updated record past the cap", () => {
    const records = new ProgramStatusRecords();
    for (let index = 0; index < 256; index += 1) {
      records.apply({ state: "idle", id: `r${index}` });
    }
    records.apply({ state: "idle", id: "r0" });
    records.apply({ state: "idle", id: "r256" });

    expect(records.size).toBe(256);
    expect(records.get("r0")).toMatchObject({ state: "idle" });
    expect(records.get("r1")).toBeUndefined();
    expect(records.get("r256")).toMatchObject({ state: "idle" });
  });

  it("updating an existing record never evicts", () => {
    const records = new ProgramStatusRecords();
    for (let index = 0; index < 256; index += 1) {
      records.apply({ state: "idle", id: `r${index}` });
    }
    records.apply({ state: "working", id: "r0" });

    expect(records.size).toBe(256);
    expect(records.get("r0")).toMatchObject({ state: "working" });
    expect(records.get("r255")).toMatchObject({ state: "idle" });
  });
});

describe("ProgramStatusRecords — app inheritance", () => {
  it("takes app from the nearest ancestor, skipping missing parents, up to the root", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "working", id: null, app: "deploy" });
    records.apply({ state: "working", id: "eu", app: "terraform" });
    records.apply({ state: "blocked", id: "eu/db/migrate", kind: "permission" });
    records.apply({ state: "working", id: "us/web" });

    expect(records.get("eu/db/migrate")?.app).toBe("terraform");
    expect(records.get("us/web")?.app).toBe("deploy");
  });

  it("keeps a record's own app and leaves app absent without an ancestor that has one", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "working", id: null });
    records.apply({ state: "working", id: "build", app: "cargo" });
    records.apply({ state: "working", id: "build/test", app: "nextest" });
    records.apply({ state: "working", id: "lint" });

    expect(records.get("build/test")?.app).toBe("nextest");
    expect(records.get("lint")).toEqual({ state: "working", id: "lint" });
  });
});

describe("ProgramStatusRecords — lifetime", () => {
  it("drops working and blocked but keeps idle, done, and error", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "working", id: "w" });
    records.apply({ state: "blocked", id: "b" });
    records.apply({ state: "idle", id: "i" });
    records.apply({ state: "done", id: "d" });
    records.apply({ state: "error", id: "e" });

    expect(records.dropLiveRecords()).toBe(true);

    expect(records.get("w")).toBeUndefined();
    expect(records.get("b")).toBeUndefined();
    expect(records.get("i")).toMatchObject({ state: "idle" });
    expect(records.get("d")).toMatchObject({ state: "done" });
    expect(records.get("e")).toMatchObject({ state: "error" });
    expect(records.resolve()).toBe("error");
  });

  it("reports no change when no live records exist", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "idle", id: null });

    expect(records.dropLiveRecords()).toBe(false);
    expect(records.resolve()).toBe("idle");
  });

  it("reports no change when empty", () => {
    expect(new ProgramStatusRecords().dropLiveRecords()).toBe(false);
  });
});

describe("ProgramStatusRecords — resolve precedence", () => {
  it("orders blocked above working above error above done above idle", () => {
    const records = new ProgramStatusRecords();
    records.apply({ state: "idle", id: "i" });
    expect(records.resolve()).toBe("idle");

    records.apply({ state: "done", id: "d" });
    expect(records.resolve()).toBe("done");

    records.apply({ state: "error", id: "e" });
    expect(records.resolve()).toBe("error");

    records.apply({ state: "working", id: "w" });
    expect(records.resolve()).toBe("working");

    records.apply({ state: "blocked", id: "b" });
    expect(records.resolve()).toBe("blocked");

    records.apply({ state: "clear", id: "b" });
    expect(records.resolve()).toBe("working");
  });
});
