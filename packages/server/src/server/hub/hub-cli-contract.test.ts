import { afterEach, expect, test } from "vitest";
import { HubRelationshipHarness } from "./test-utils/relationship-harness.js";

let relationship: HubRelationshipHarness | null = null;

afterEach(async () => {
  await relationship?.close();
  relationship = null;
});

test("the Hub CLI connects, reports status, and disconnects through the daemon", async () => {
  relationship = await HubRelationshipHarness.start();
  const connected = await relationship.beginConnect().result;
  relationship.connectLatestSocket();

  const status = await relationship.status();
  const enrollment = relationship.enrollmentAttempts()[0];
  const secret = relationship.relationshipFile()?.credential?.secret;
  const disconnected = await relationship.disconnect();

  expect(connected.state).toBe("connecting");
  expect(status.state).toBe("connected");
  expect(relationship.loggableValues(status)).not.toContain(secret);
  expect(relationship.loggableValues(status)).not.toContain(enrollment.credentialVerifier);
  expect(relationship.loggableValues(status)).not.toContain(enrollment.token);
  expect(relationship.loggableValues(status)).not.toContain(enrollment.idempotencyKey);
  expect(disconnected.state).toBe("not_connected");
}, 30_000);
