import { describe, expect, it } from "vitest";
import { DeliveryError, postNotification, type NotificationHttp } from "./notification-http.js";
import { createNotificationHttpFake } from "./test-utils.js";

describe("notification HTTP failure categories", () => {
  it("keeps response-body timeouts retryable", async () => {
    const http: NotificationHttp = async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => "",
      json: async () => {
        throw new DOMException("private body", "TimeoutError");
      },
    });
    await expect(
      postNotification(http, "https://provider.example.com", {}, {}),
    ).rejects.toMatchObject({ category: "network_or_timeout", retryable: true });
  });
  it("treats malformed response JSON as a permanent failure without leaking content", async () => {
    const http: NotificationHttp = async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => "",
      json: async () => {
        throw new SyntaxError("private token");
      },
    });
    await expect(postNotification(http, "https://provider.example.com", {}, {})).rejects.toEqual(
      new DeliveryError("invalid_response", false),
    );
  });
  it("uses Retry-After HTTP dates and sanitizes provider error responses", async () => {
    const fake = createNotificationHttpFake([
      {
        status: 429,
        headers: { "Retry-After": "Wed, 14 Oct 2026 12:01:00 GMT" },
        body: { token: "private" },
      },
    ]);
    await expect(
      postNotification(fake.request, "https://provider.example.com", {}, {}, () =>
        Date.parse("2026-10-14T12:00:00Z"),
      ),
    ).rejects.toMatchObject({ retryable: true, status: 429, retryAfterMs: 60_000 });
    expect(fake.requests[0].init.signal?.aborted).toBe(false);
    expect(fake.requests[0].init.redirect).toBe("error");
  });
});
