import { describe, expect, it } from "vitest";
import {
  GetDaemonConfigResponseMessageSchema,
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
  SetDaemonConfigResponseMessageSchema,
  StatusMessageSchema,
} from "./messages.js";

describe("relay daemon config protocol compatibility", () => {
  it("accepts the full self-hosted relay config", () => {
    const relay = {
      enabled: true,
      endpoint: "relay.internal.example:443",
      publicEndpoint: "relay.example.com:443",
      useTls: true,
      publicUseTls: true,
    };

    expect(
      MutableDaemonConfigSchema.parse({
        relay,
        mcp: { injectIntoAgents: true },
      }).relay,
    ).toEqual(relay);
    expect(MutableDaemonConfigPatchSchema.parse({ relay }).relay).toEqual(relay);
  });

  it("keeps relay endpoint config metadata optional for older peers", () => {
    const olderStatus = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "older-host",
        features: { relayConfig: true },
      },
    });
    expect(olderStatus.payload.features?.relayEndpointConfig).toBeUndefined();

    const baseConfig = {
      relay: { enabled: true },
      mcp: { injectIntoAgents: true },
    };
    expect(
      GetDaemonConfigResponseMessageSchema.parse({
        type: "get_daemon_config_response",
        payload: { requestId: "get-1", config: baseConfig },
      }).payload.overrideControlledPaths,
    ).toBeUndefined();
    expect(
      SetDaemonConfigResponseMessageSchema.parse({
        type: "set_daemon_config_response",
        payload: { requestId: "set-1", config: baseConfig },
      }).payload.restartRequiredPaths,
    ).toBeUndefined();
  });

  it("round-trips relay endpoint config response metadata", () => {
    const config = {
      relay: {
        enabled: true,
        endpoint: "relay.internal.example:443",
        publicEndpoint: "relay.example.com:443",
        useTls: true,
        publicUseTls: true,
      },
      mcp: { injectIntoAgents: true },
    };

    const getResponse = GetDaemonConfigResponseMessageSchema.parse({
      type: "get_daemon_config_response",
      payload: {
        requestId: "get-1",
        config,
        overrideControlledPaths: ["daemon.relay.endpoint"],
      },
    });
    expect(getResponse.payload.overrideControlledPaths).toEqual(["daemon.relay.endpoint"]);

    const setResponse = SetDaemonConfigResponseMessageSchema.parse({
      type: "set_daemon_config_response",
      payload: {
        requestId: "set-1",
        config,
        restartRequiredPaths: ["daemon.relay.endpoint"],
        overrideControlledPaths: ["daemon.relay.publicEndpoint"],
      },
    });
    expect(setResponse.payload.restartRequiredPaths).toEqual(["daemon.relay.endpoint"]);
    expect(setResponse.payload.overrideControlledPaths).toEqual(["daemon.relay.publicEndpoint"]);
  });
});
