// @ts-nocheck
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import { ensureValidJson } from "../json-utils.js";
import type { BrowserManager } from "./browser-manager.js";

export function registerBrowserTools(
  server: McpServer,
  browserManager: BrowserManager,
  logger: Logger,
): void {
  server.registerTool(
    "browser_launch",
    {
      title: "Launch browser",
      description: "Launch a new browser instance. Optionally navigate to a URL after launch.",
      inputSchema: {
        url: z.string().url().optional().describe("URL to navigate to after launch"),
      },
      outputSchema: {
        browserId: z.string(),
        url: z.string(),
        title: z.string(),
      },
    },
    async ({ url }) => {
      try {
        const result = await browserManager.launch({ url });
        return {
          content: [],
          structuredContent: ensureValidJson({
            browserId: result.browserId,
            url: result.url,
            title: result.title,
          }),
        };
      } catch (error) {
        logger.error({ error }, "Failed to launch browser");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({
            browserId: "",
            url: "",
            title: "",
          }),
        };
      }
    },
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate to URL",
      description: "Navigate a browser instance to the specified URL.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        url: z.string().url().describe("URL to navigate to"),
      },
      outputSchema: {
        url: z.string(),
        title: z.string(),
      },
    },
    async ({ browserId, url }) => {
      try {
        const result = await browserManager.navigate(browserId, url);
        return {
          content: [],
          structuredContent: ensureValidJson({
            url: result.url,
            title: result.title,
          }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to navigate");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ url: "", title: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click element",
      description: "Click an element in the browser matched by CSS selector.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        selector: z.string().describe("CSS selector of the element to click"),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ browserId, selector }) => {
      try {
        await browserManager.click(browserId, selector);
        return {
          content: [],
          structuredContent: ensureValidJson({ success: true }),
        };
      } catch (error) {
        logger.error({ error, browserId, selector }, "Failed to click element");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ success: false }),
        };
      }
    },
  );

  server.registerTool(
    "browser_fill",
    {
      title: "Fill form field",
      description:
        "Fill a form field in the browser with the specified value, matched by CSS selector.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        selector: z.string().describe("CSS selector of the form field"),
        value: z.string().describe("Value to fill into the field"),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ browserId, selector, value }) => {
      try {
        await browserManager.fill(browserId, selector, value);
        return {
          content: [],
          structuredContent: ensureValidJson({ success: true }),
        };
      } catch (error) {
        logger.error({ error, browserId, selector }, "Failed to fill form field");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ success: false }),
        };
      }
    },
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Take screenshot",
      description:
        "Capture a screenshot of the current browser page. Returns the image as base64-encoded JPEG.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ browserId }) => {
      try {
        const result = await browserManager.screenshot(browserId);
        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
          structuredContent: ensureValidJson({ success: true }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to take screenshot");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ success: false }),
        };
      }
    },
  );

  server.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate JavaScript",
      description:
        "Execute a JavaScript expression in the browser page context and return the result.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        expression: z.string().describe("JavaScript expression to evaluate"),
      },
      outputSchema: {
        result: z.string(),
      },
    },
    async ({ browserId, expression }) => {
      try {
        const evalResult = await browserManager.evaluate(browserId, expression);
        return {
          content: [],
          structuredContent: ensureValidJson({ result: evalResult.result }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to evaluate JavaScript");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ result: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_get_text",
    {
      title: "Get page text",
      description: "Extract the visible text content from the current browser page.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
      },
      outputSchema: {
        text: z.string(),
      },
    },
    async ({ browserId }) => {
      try {
        const text = await browserManager.getText(browserId);
        return {
          content: [],
          structuredContent: ensureValidJson({ text }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to get page text");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ text: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_go_back",
    {
      title: "Go back",
      description: "Navigate the browser back in history.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
      },
      outputSchema: {
        url: z.string(),
        title: z.string(),
      },
    },
    async ({ browserId }) => {
      try {
        const result = await browserManager.goBack(browserId);
        return {
          content: [],
          structuredContent: ensureValidJson({
            url: result.url,
            title: result.title,
          }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to go back");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ url: "", title: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_go_forward",
    {
      title: "Go forward",
      description: "Navigate the browser forward in history.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
      },
      outputSchema: {
        url: z.string(),
        title: z.string(),
      },
    },
    async ({ browserId }) => {
      try {
        const result = await browserManager.goForward(browserId);
        return {
          content: [],
          structuredContent: ensureValidJson({
            url: result.url,
            title: result.title,
          }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to go forward");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ url: "", title: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close browser",
      description: "Close a browser instance and release its resources.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance to close"),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ browserId }) => {
      try {
        await browserManager.close(browserId);
        return {
          content: [],
          structuredContent: ensureValidJson({ success: true }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to close browser");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ success: false }),
        };
      }
    },
  );
}
