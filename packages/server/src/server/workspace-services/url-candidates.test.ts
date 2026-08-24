import { describe, expect, it } from "vitest";
import { findLocalServiceUrls, LocalServiceUrlStreamDetector } from "./url-candidates.js";

describe("findLocalServiceUrls", () => {
  it("extracts ANSI-wrapped loopback URLs and removes prose punctuation", () => {
    expect(
      findLocalServiceUrls(
        "\u001b[32mready\u001b[0m at http://localhost:5173/app, and https://ui.localhost:8443.",
      ),
    ).toEqual([
      {
        url: "http://localhost:5173/app",
        protocol: "http:",
        hostname: "localhost",
        port: 5173,
      },
      {
        url: "https://ui.localhost:8443/",
        protocol: "https:",
        hostname: "ui.localhost",
        port: 8443,
      },
    ]);
  });

  it("accepts IPv4 and IPv6 loopback while rejecting unsafe hosts, schemes, and ports", () => {
    const output = [
      "http://127.0.0.1:3000",
      "http://127.1.2.3:3001",
      "http://[::1]:3002",
      "http://0.0.0.0:3003",
      "http://example.com:3004",
      "ftp://localhost:3005",
      "http://localhost:0",
      "http://localhost:65536",
    ].join("\n");
    expect(findLocalServiceUrls(output).map((candidate) => candidate.port)).toEqual([
      3000, 3001, 3002,
    ]);
  });

  it("deduplicates repeated announcements", () => {
    expect(findLocalServiceUrls("http://localhost:3000 http://localhost:3000")).toHaveLength(1);
  });
});

describe("LocalServiceUrlStreamDetector", () => {
  it("recognizes a URL split across terminal output chunks", () => {
    const detector = new LocalServiceUrlStreamDetector();
    expect(detector.push("Local: http://local")).toEqual([]);
    expect(detector.push("host:4173/preview\n")).toEqual([
      {
        url: "http://localhost:4173/preview",
        protocol: "http:",
        hostname: "localhost",
        port: 4173,
      },
    ]);
  });

  it("does not re-emit an unchanged URL from the rolling buffer", () => {
    const detector = new LocalServiceUrlStreamDetector();
    expect(detector.push("http://localhost:3000")).toHaveLength(1);
    expect(detector.push("\nserver still running")).toEqual([]);
    expect(detector.push("\nhttp://localhost:3000/changed")).toMatchObject([
      { port: 3000, url: "http://localhost:3000/changed" },
    ]);
  });

  it("bounds retained output", () => {
    const detector = new LocalServiceUrlStreamDetector(64);
    detector.push("x".repeat(100));
    expect(detector.push(" http://localhost:9000")).toHaveLength(1);
    detector.clear();
    expect(detector.push(":9001")).toEqual([]);
  });
});
