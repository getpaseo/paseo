import { describe, expect, it, vi } from "vitest";

// Each mock records that its module was imported. Building the command tree, which every command
// does first, imports none of them: the daemon client and the protocol's message schemas load when
// a command connects, the hub response schemas on the first hub request.
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("@getpaseo/client", () => {
  loaded.add("@getpaseo/client");
  return {};
});
vi.mock("@getpaseo/client/node", () => {
  loaded.add("@getpaseo/client/node");
  return {};
});
vi.mock("@getpaseo/client/internal/daemon-client", () => {
  loaded.add("@getpaseo/client/internal/daemon-client");
  return {};
});
vi.mock("@getpaseo/protocol/messages", () => {
  loaded.add("@getpaseo/protocol/messages");
  return {};
});
vi.mock("./commands/hub/hub-client/internal/contracts.js", () => {
  loaded.add("hub contracts");
  return {};
});

describe("CLI start-up", () => {
  it("builds the command tree without loading the daemon client or the message schemas", async () => {
    const { createCli } = await import("./cli.js");
    expect(createCli().helpInformation()).toContain("Usage: paseo");
    expect([...loaded]).toEqual([]);
  });
});
