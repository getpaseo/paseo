import { describe, expect, it, vi } from "vitest";
import { normalizeWorkspaceBrowserUrl, useBrowserStore } from "./browser-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
}));

describe("browser store", () => {
  it("normalizes local development hosts to http by default", () => {
    expect(normalizeWorkspaceBrowserUrl("localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeWorkspaceBrowserUrl("localhost/path")).toBe("http://localhost/path");
    expect(normalizeWorkspaceBrowserUrl("127.0.0.1:3000/path")).toBe("http://127.0.0.1:3000/path");
    expect(normalizeWorkspaceBrowserUrl("192.168.0.8")).toBe("http://192.168.0.8");
    expect(normalizeWorkspaceBrowserUrl("[::1]:5173")).toBe("http://[::1]:5173");
  });

  it("normalizes public hosts to https by default", () => {
    expect(normalizeWorkspaceBrowserUrl("example.com")).toBe("https://example.com");
    expect(normalizeWorkspaceBrowserUrl("//example.com/path")).toBe("https://example.com/path");
  });

  it("keeps explicit protocols unchanged", () => {
    expect(normalizeWorkspaceBrowserUrl("http://localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeWorkspaceBrowserUrl("https://localhost:8081")).toBe("https://localhost:8081");
    expect(normalizeWorkspaceBrowserUrl("file:///tmp/example.html")).toBe(
      "file:///tmp/example.html",
    );
  });

  it("normalizes browser URLs when creating and updating records", () => {
    useBrowserStore.setState({ browsersById: {} });

    const browserId = useBrowserStore.getState().createBrowser({ initialUrl: "localhost:8081" });
    expect(useBrowserStore.getState().browsersById[browserId]?.url).toBe("http://localhost:8081");

    useBrowserStore.getState().updateBrowser(browserId, { url: "example.com/path" });
    expect(useBrowserStore.getState().browsersById[browserId]?.url).toBe(
      "https://example.com/path",
    );
  });
});
