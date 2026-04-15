import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";

// Mock playwright-core so tests don't require a real Chromium install
const mockPage = {
  url: vi.fn().mockReturnValue("about:blank"),
  title: vi.fn().mockResolvedValue(""),
  goto: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(""),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
  goBack: vi.fn().mockResolvedValue(undefined),
  goForward: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  mainFrame: vi.fn(),
};

const mockContext = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  isConnected: vi.fn().mockReturnValue(true),
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};

vi.mock("playwright-core", () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mockBrowser),
  },
}));

// Import after mock
const { BrowserManager } = await import("./browser-manager.js");

describe("BrowserManager", () => {
  const logger = createTestLogger();
  let manager: InstanceType<typeof BrowserManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new BrowserManager({ logger });
    mockPage.url.mockReturnValue("about:blank");
    mockPage.title.mockResolvedValue("");
  });

  describe("launch", () => {
    it("returns a browserId, url, and title", async () => {
      const result = await manager.launch();
      expect(result.browserId).toBeDefined();
      expect(typeof result.browserId).toBe("string");
      expect(result.url).toBe("about:blank");
      expect(result.title).toBe("");
    });

    it("navigates if url option is provided", async () => {
      mockPage.url.mockReturnValue("https://example.com");
      mockPage.title.mockResolvedValue("Example");

      const result = await manager.launch({ url: "https://example.com" });
      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", expect.any(Object));
      expect(result.url).toBe("https://example.com");
      expect(result.title).toBe("Example");
    });

    it("creates isolated contexts for each launch", async () => {
      const r1 = await manager.launch();
      const r2 = await manager.launch();
      expect(r1.browserId).not.toBe(r2.browserId);
      expect(mockBrowser.newContext).toHaveBeenCalledTimes(2);
    });
  });

  describe("navigate", () => {
    it("navigates and returns current state", async () => {
      const { browserId } = await manager.launch();
      mockPage.url.mockReturnValue("https://test.com");
      mockPage.title.mockResolvedValue("Test");

      const result = await manager.navigate(browserId, "https://test.com");
      expect(result.url).toBe("https://test.com");
      expect(result.title).toBe("Test");
    });

    it("throws for unknown browserId", async () => {
      await expect(manager.navigate("unknown-id", "https://test.com")).rejects.toThrow(
        "No browser context found",
      );
    });
  });

  describe("getPageState", () => {
    it("returns url and title", async () => {
      const { browserId } = await manager.launch();
      mockPage.url.mockReturnValue("https://state.com");
      mockPage.title.mockResolvedValue("State Page");

      const state = await manager.getPageState(browserId);
      expect(state.url).toBe("https://state.com");
      expect(state.title).toBe("State Page");
    });
  });

  describe("screenshot", () => {
    it("returns base64 jpeg data", async () => {
      const { browserId } = await manager.launch();
      const result = await manager.screenshot(browserId);
      expect(result.mimeType).toBe("image/jpeg");
      expect(typeof result.data).toBe("string");
    });
  });

  describe("getText", () => {
    it("returns page text", async () => {
      const { browserId } = await manager.launch();
      mockPage.evaluate.mockResolvedValueOnce("Hello World");
      const text = await manager.getText(browserId);
      expect(text).toBe("Hello World");
    });
  });

  describe("goBack / goForward", () => {
    it("navigates back", async () => {
      const { browserId } = await manager.launch();
      mockPage.url.mockReturnValue("https://prev.com");
      mockPage.title.mockResolvedValue("Previous");

      const result = await manager.goBack(browserId);
      expect(mockPage.goBack).toHaveBeenCalled();
      expect(result.url).toBe("https://prev.com");
    });

    it("navigates forward", async () => {
      const { browserId } = await manager.launch();
      mockPage.url.mockReturnValue("https://next.com");
      mockPage.title.mockResolvedValue("Next");

      const result = await manager.goForward(browserId);
      expect(mockPage.goForward).toHaveBeenCalled();
      expect(result.url).toBe("https://next.com");
    });
  });

  describe("close", () => {
    it("closes a context and removes it", async () => {
      const { browserId } = await manager.launch();
      await manager.close(browserId);
      expect(mockContext.close).toHaveBeenCalled();

      // Subsequent calls to the same id should not throw, just warn
      await manager.close(browserId);
    });
  });

  describe("dispose", () => {
    it("closes all contexts and the browser", async () => {
      await manager.launch();
      await manager.launch();
      await manager.dispose();
      expect(mockContext.close).toHaveBeenCalledTimes(2);
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it("is safe to call multiple times", async () => {
      await manager.dispose();
      await manager.dispose();
    });
  });

  describe("getActiveBrowserIds", () => {
    it("returns all active ids", async () => {
      const r1 = await manager.launch();
      const r2 = await manager.launch();
      const ids = manager.getActiveBrowserIds();
      expect(ids).toContain(r1.browserId);
      expect(ids).toContain(r2.browserId);
      expect(ids).toHaveLength(2);
    });
  });
});
