import { describe, expect, it } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "../../shared/messages.js";

describe("Browser message schemas", () => {
  describe("inbound (client → server)", () => {
    it("parses browser_launch_request", () => {
      const msg = {
        type: "browser_launch_request",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_launch_request with url", () => {
      const msg = {
        type: "browser_launch_request",
        url: "https://example.com",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_state_request", () => {
      const msg = {
        type: "browser_state_request",
        browserId: "b-1",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_screenshot_request", () => {
      const msg = {
        type: "browser_screenshot_request",
        browserId: "b-1",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_navigate_request", () => {
      const msg = {
        type: "browser_navigate_request",
        browserId: "b-1",
        url: "https://example.com",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_go_back_request", () => {
      const msg = {
        type: "browser_go_back_request",
        browserId: "b-1",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_go_forward_request", () => {
      const msg = {
        type: "browser_go_forward_request",
        browserId: "b-1",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_close_request", () => {
      const msg = {
        type: "browser_close_request",
        browserId: "b-1",
        requestId: "req-1",
      };
      expect(() => SessionInboundMessageSchema.parse(msg)).not.toThrow();
    });
  });

  describe("outbound (server → client)", () => {
    it("parses browser_launch_response", () => {
      const msg = {
        type: "browser_launch_response",
        payload: {
          browserId: "b-1",
          url: "about:blank",
          title: "",
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_state_response", () => {
      const msg = {
        type: "browser_state_response",
        payload: {
          browserId: "b-1",
          url: "https://example.com",
          title: "Example",
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_screenshot_response", () => {
      const msg = {
        type: "browser_screenshot_response",
        payload: {
          browserId: "b-1",
          data: "base64data",
          mimeType: "image/jpeg",
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_navigate_response", () => {
      const msg = {
        type: "browser_navigate_response",
        payload: {
          browserId: "b-1",
          url: "https://example.com",
          title: "Example",
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_go_back_response", () => {
      const msg = {
        type: "browser_go_back_response",
        payload: {
          browserId: "b-1",
          url: "https://prev.com",
          title: "Previous",
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_go_forward_response", () => {
      const msg = {
        type: "browser_go_forward_response",
        payload: {
          browserId: "b-1",
          url: "https://next.com",
          title: "Next",
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });

    it("parses browser_close_response", () => {
      const msg = {
        type: "browser_close_response",
        payload: {
          browserId: "b-1",
          success: true,
          requestId: "req-1",
        },
      };
      expect(() => SessionOutboundMessageSchema.parse(msg)).not.toThrow();
    });
  });
});
