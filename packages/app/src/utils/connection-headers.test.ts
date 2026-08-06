import { describe, expect, it } from "vitest";
import { prepareConnectionHeaders } from "./connection-headers";

describe("prepareConnectionHeaders", () => {
  it("trims and returns custom headers", () => {
    expect(
      prepareConnectionHeaders([
        { id: 1, name: " X-Tenant ", value: " acme " },
        { id: 2, name: "X-Empty", value: "" },
      ]),
    ).toEqual({ headers: { "X-Tenant": "acme", "X-Empty": "" } });
  });

  it("ignores completely empty draft rows", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "", value: "" }])).toEqual({});
  });

  it("requires a name when a value is entered", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "", value: "acme" }])).toEqual({
      issue: { type: "missingName" },
    });
  });

  it("rejects invalid and duplicate names case-insensitively", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "Bad Header", value: "value" }])).toEqual({
      issue: { type: "invalidName", name: "Bad Header" },
    });
    expect(
      prepareConnectionHeaders([
        { id: 1, name: "X-Tenant", value: "one" },
        { id: 2, name: "x-tenant", value: "two" },
      ]),
    ).toEqual({ issue: { type: "duplicateName", name: "x-tenant" } });
  });

  it("rejects line breaks in values", () => {
    expect(prepareConnectionHeaders([{ id: 1, name: "X-Test", value: "one\ntwo" }])).toEqual({
      issue: { type: "invalidValue", name: "X-Test" },
    });
  });
});
