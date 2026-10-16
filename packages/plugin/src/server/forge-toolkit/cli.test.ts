import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ForgeCommandError } from "../../forge.js";
import { parseCliJsonOutput, redactCommandArgs } from "./cli.js";

const createCommandError = (params: {
  args: string[];
  cwd: string;
  exitCode: number | null;
  stderr: string;
}) => new ForgeCommandError({ brand: "Acme", binary: "acme" }, params);

describe("redactCommandArgs", () => {
  it("redacts both spellings of a sensitive flag", () => {
    expect(
      redactCommandArgs(["api", "--body", "secret", "--search=private", "--page", "1"], {
        sensitiveFlags: ["--body", "--search"],
      }),
    ).toEqual(["api", "--body", "<redacted>", "--search=<redacted>", "--page", "1"]);
  });

  it("leaves a trailing sensitive flag without a value alone", () => {
    expect(redactCommandArgs(["api", "--body"], { sensitiveFlags: ["--body"] })).toEqual([
      "api",
      "--body",
    ]);
  });
});

describe("parseCliJsonOutput", () => {
  it("returns parsed data for matching JSON", () => {
    expect(
      parseCliJsonOutput({
        commandName: "acme api",
        args: ["api"],
        cwd: "/repo",
        stdout: '{"number":7}',
        schema: z.object({ number: z.number() }),
        createCommandError,
      }),
    ).toEqual({ number: 7 });
  });

  it("raises a command error for invalid JSON and for a schema mismatch", () => {
    const call = (stdout: string) =>
      parseCliJsonOutput({
        commandName: "acme api",
        args: ["api"],
        cwd: "/repo",
        stdout,
        schema: z.object({ number: z.number() }),
        createCommandError,
      });

    // The message names the command; the detail lands in `stderr`, which is what
    // the daemon surfaces.
    const stderrOf = (stdout: string) => {
      try {
        call(stdout);
      } catch (error) {
        return (error as ForgeCommandError).stderr;
      }
      throw new Error("expected parseCliJsonOutput to throw");
    };

    expect(stderrOf("not json")).toContain("did not return valid JSON");
    expect(stderrOf('{"number":"7"}')).toContain("did not match the expected schema");
  });
});
