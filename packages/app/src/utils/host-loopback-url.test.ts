import { describe, expect, it, vi } from "vitest";

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
}));

const { isLoopbackUrl, rewriteLoopbackUrl } = await import("./host-loopback-url");

describe("rewriteLoopbackUrl", () => {
  it("points a daemon-local URL at the host the client reaches", () => {
    expect(rewriteLoopbackUrl("http://127.0.0.1:6768/open-project", "100.76.77.158:6767")).toBe(
      "http://100.76.77.158:6768/open-project",
    );
    expect(rewriteLoopbackUrl("http://localhost:3110", "100.76.77.158:6767")).toBe(
      "http://100.76.77.158:3110",
    );
  });

  it("keeps real URLs and clients on the daemon's own machine as they are", () => {
    expect(rewriteLoopbackUrl("https://example.com/a", "100.76.77.158:6767")).toBe(
      "https://example.com/a",
    );
    expect(rewriteLoopbackUrl("http://127.0.0.1:4007/", "127.0.0.1:6767")).toBe(
      "http://127.0.0.1:4007/",
    );
    expect(rewriteLoopbackUrl("http://127.0.0.1:4007/", null)).toBe("http://127.0.0.1:4007/");
    expect(isLoopbackUrl("http://[::1]:80/")).toBe(true);
  });
});
