import { describe, expect, test } from "vitest";
import {
  buildManagedMcpServerPatch,
  createManagedMcpServerFormState,
  managedMcpViewToPatch,
} from "./managed-mcp-server-form";

describe("managed MCP server form", () => {
  test("builds an HTTP server with direct and environment-backed headers", () => {
    const state = createManagedMcpServerFormState();
    state.name = "hub";
    state.target = "https://mcp.example.test/mcp";
    state.secrets = [
      {
        id: "authorization",
        key: "Authorization",
        source: "value",
        value: "Bearer token",
        preserveExisting: false,
      },
      {
        id: "tenant",
        key: "x-tenant",
        source: "env",
        value: "MCP_TENANT",
        preserveExisting: false,
      },
    ];

    expect(buildManagedMcpServerPatch(state)).toEqual({
      name: "hub",
      server: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: {
          Authorization: { source: "value", value: "Bearer token" },
          "x-tenant": { source: "env", name: "MCP_TENANT" },
        },
        enabled: true,
        alwaysLoad: false,
      },
    });
  });

  test("keeps a redacted direct value when editing", () => {
    expect(
      managedMcpViewToPatch({
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: { source: "value", configured: true } },
      }),
    ).toEqual({
      type: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: { source: "existing" } },
      enabled: true,
      alwaysLoad: false,
    });
  });

  test("rejects non-HTTP URLs and duplicate secret names", () => {
    const state = createManagedMcpServerFormState();
    state.name = "hub";
    state.target = "file:///tmp/mcp";
    expect(() => buildManagedMcpServerPatch(state)).toThrow("must use HTTP or HTTPS");

    state.target = "https://mcp.example.test";
    state.secrets = [
      {
        id: "one",
        key: "Authorization",
        source: "env",
        value: "ONE",
        preserveExisting: false,
      },
      {
        id: "two",
        key: "Authorization",
        source: "env",
        value: "TWO",
        preserveExisting: false,
      },
    ];
    expect(() => buildManagedMcpServerPatch(state)).toThrow("must be unique");
  });

  test("rejects credentials embedded in a server URL", () => {
    const state = createManagedMcpServerFormState();
    state.name = "hub";
    state.target = "https://user:private-token@mcp.example.test/mcp";

    expect(() => buildManagedMcpServerPatch(state)).toThrow("valid MCP server URL");
  });
});
