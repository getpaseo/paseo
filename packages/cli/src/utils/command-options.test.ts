import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { createCli } from "../cli.js";
import { withGlobalOptions } from "./command-options.js";

async function parseHost(argv: string[]): Promise<string | undefined> {
  const program = createCli().exitOverride();
  let receivedHost: string | undefined;

  program.commands
    .find((command) => command.name() === "ls")!
    .action(
      withGlobalOptions((options: { host?: string }) => {
        receivedHost = options.host;
      }),
    );

  await program.parseAsync(argv, { from: "user" });
  return receivedHost;
}

describe("global command options", () => {
  it("passes a host declared before the command to its handler", async () => {
    await expect(parseHost(["--host", "global:6767", "ls"])).resolves.toBe("global:6767");
  });

  it("preserves the command-local host position", async () => {
    await expect(parseHost(["ls", "--host", "local:6767"])).resolves.toBe("local:6767");
  });

  it("rejects conflicting parent and command selectors", async () => {
    await expect(
      parseHost(["--host", "first:6767", "ls", "--host", "last:6767"]),
    ).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
  });

  it("lets local-only commands ignore a global host", async () => {
    const program = new Command().exitOverride().option("--host <host>");
    let called = false;
    program.command("status").action(() => {
      called = true;
    });

    await program.parseAsync(["--host", "ignored:6767", "status"], { from: "user" });

    expect(called).toBe(true);
  });
});
