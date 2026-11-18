import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FLEET_CONTROL_PORTFOLIO_AGENT_ID,
  FleetCommitmentOperateRequestSchema,
  FleetControlMarkerSchema,
} from "./fleet-control.js";
import {
  parseServerInfoStatusPayload,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const commitmentId = "64e89b9a-ff01-4cd8-b3f8-202bd276bc1d";
const operationRequestId = "728f8f21-98d5-40c8-ae69-95013fe5b120";

describe("fleet control protocol", () => {
  it("accepts the fixed marker shape and rejects non-ASCII or unsafe values", () => {
    expect(
      FleetControlMarkerSchema.parse([
        "fleet-control.v1",
        commitmentId,
        "open",
        0,
        null,
        FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      ]),
    ).toHaveLength(6);
    expect(() =>
      FleetControlMarkerSchema.parse([
        "fleet-control.v1",
        commitmentId,
        "paused",
        Number.MAX_SAFE_INTEGER + 1,
        operationRequestId,
        FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      ]),
    ).toThrow();
    expect(() =>
      FleetCommitmentOperateRequestSchema.parse({
        type: "fleet.commitment.operate.request",
        requestId: "transport-é",
        operationRequestId,
        commitmentId,
        action: "pause",
        expectedPriorDigest: "0".repeat(64),
        expectedPortfolioAgentId: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      }),
    ).toThrow();
  });

  it("keeps old server_info payloads valid and adds only optional capability state", () => {
    expect(
      parseServerInfoStatusPayload({ status: "server_info", serverId: "old-daemon" })?.features
        ?.fleetCommitmentControls,
    ).toBeUndefined();
    expect(
      parseServerInfoStatusPayload({
        status: "server_info",
        serverId: "new-daemon",
        features: { fleetCommitmentControls: true },
      })?.features?.fleetCommitmentControls,
    ).toBe(true);
    const legacyClientSchema = z.object({
      status: z.literal("server_info"),
      serverId: z.string(),
      features: z.object({ creationLifecycle: z.boolean().optional() }).optional(),
    });
    expect(
      legacyClientSchema.parse({
        status: "server_info",
        serverId: "new-daemon",
        features: { fleetCommitmentControls: true },
      }),
    ).toEqual({ status: "server_info", serverId: "new-daemon", features: {} });
  });

  it("includes the Fleet requests and responses in the session wire unions", () => {
    const inbound = SessionInboundMessageSchema.parse({
      type: "fleet.commitment.operate.request",
      requestId: "transport-1",
      operationRequestId,
      commitmentId,
      action: "pause",
      expectedPriorDigest: "0".repeat(64),
      expectedPortfolioAgentId: FLEET_CONTROL_PORTFOLIO_AGENT_ID,
      principalId: "service:firstmate-deck",
    });
    expect(inbound.type).toBe("fleet.commitment.operate.request");
    expect("principalId" in inbound).toBe(false);
    expect(
      SessionOutboundMessageSchema.parse({
        type: "fleet.commitment.read.response",
        payload: {
          requestId: "transport-2",
          commitmentId,
          marker: [
            "fleet-control.v1",
            commitmentId,
            "open",
            0,
            null,
            FLEET_CONTROL_PORTFOLIO_AGENT_ID,
          ],
          digest: "0".repeat(64),
        },
      }).type,
    ).toBe("fleet.commitment.read.response");
  });
});
