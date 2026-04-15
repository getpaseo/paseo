// @ts-nocheck
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "pino";
import { ensureValidJson } from "../json-utils.js";
import type { BrowserManager } from "./browser-manager.js";

export function registerBrowserTools(
  server: McpServer,
  browserManager: BrowserManager | any,
  logger: Logger,
): void {
  server.registerTool(
    "browser_launch",
    {
      title: "Launch browser",
      description:
        "Launch a real browser tab visible to the user. The browser runs as a webview in the app — the user can see and interact with it. Use this to open web pages for testing, verification, or browsing documentation. Optionally navigate to a URL after launch.",
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
      description:
        "Navigate the browser to the specified URL. The user will see the page loading in real time in the browser tab.",
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
      description:
        "Click an element in the browser matched by CSS selector. The user will see the click happen in real time. Use browser_get_text or browser_evaluate to inspect the result instead of taking a screenshot.",
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
        "Fill a form field in the browser with the specified value, matched by CSS selector. The user will see the text being entered in real time.",
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
    "browser_get_text",
    {
      title: "Get page text",
      description:
        "Extract the visible text content from the current browser page. This is the PREFERRED way to read page content — use this instead of browser_screenshot whenever you need to understand what's on the page. Returns the full text content of the page body.",
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
    "browser_evaluate",
    {
      title: "Evaluate JavaScript",
      description:
        "Execute a JavaScript expression in the browser page context and return the result. Use this to inspect DOM elements, check values, run assertions for e2e tests, or extract specific data from the page. Prefer this over browser_screenshot for programmatic verification.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        expression: z.string().describe("JavaScript expression to evaluate in the page context"),
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
    "browser_get_elements",
    {
      title: "Get page elements",
      description:
        "Inspect DOM elements on the current page. Returns a structured tree of elements with their tag, id, classes, attributes, text content, and CSS selectors you can use with browser_click/browser_fill. Pass a CSS selector to scope to a specific subtree, or omit to get the main interactive elements on the page (forms, buttons, links, inputs).",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        selector: z
          .string()
          .optional()
          .describe(
            "Optional CSS selector to scope inspection to a specific element and its children",
          ),
        maxDepth: z.number().int().optional().describe("Maximum depth to traverse (default 4)"),
      },
      outputSchema: {
        elements: z.string(),
      },
    },
    async ({ browserId, selector, maxDepth }) => {
      try {
        const depth = maxDepth ?? 4;
        const expression = `
          (function() {
            function getSelector(el) {
              if (el.id) return '#' + el.id;
              let s = el.tagName.toLowerCase();
              if (el.className && typeof el.className === 'string') {
                s += '.' + el.className.trim().split(/\\s+/).join('.');
              }
              const parent = el.parentElement;
              if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                if (siblings.length > 1) {
                  s += ':nth-child(' + (Array.from(parent.children).indexOf(el) + 1) + ')';
                }
              }
              return s;
            }
            function serialize(el, depth) {
              if (depth <= 0) return null;
              const tag = el.tagName?.toLowerCase() || '';
              if (['script','style','noscript','svg','path'].includes(tag)) return null;
              const info = { tag: tag };
              if (el.id) info.id = el.id;
              if (el.className && typeof el.className === 'string' && el.className.trim()) {
                info.classes = el.className.trim().split(/\\s+/).slice(0, 5);
              }
              const text = el.childNodes.length <= 3 ? (el.textContent || '').trim().slice(0, 100) : '';
              if (text && !el.children.length) info.text = text;
              if (tag === 'a' && el.href) info.href = el.href;
              if (tag === 'img' && el.alt) info.alt = el.alt;
              if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                info.type = el.type || '';
                info.name = el.name || '';
                info.value = (el.value || '').slice(0, 50);
                if (el.placeholder) info.placeholder = el.placeholder;
              }
              if (tag === 'button' || el.getAttribute('role') === 'button') {
                info.text = (el.textContent || '').trim().slice(0, 80);
              }
              info.selector = getSelector(el);
              const children = Array.from(el.children)
                .map(c => serialize(c, depth - 1))
                .filter(Boolean);
              if (children.length) info.children = children;
              return info;
            }
            const root = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body"};
            if (!root) return '[]';
            return JSON.stringify(serialize(root, ${depth}), null, 2);
          })()
        `;
        const evalResult = await browserManager.evaluate(browserId, expression);
        return {
          content: [],
          structuredContent: ensureValidJson({ elements: evalResult.result }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to get page elements");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ elements: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_console_logs",
    {
      title: "Get console logs",
      description:
        "Get the browser console output (log, warn, error messages). Useful for debugging JavaScript errors, checking API responses logged to console, or verifying application behavior. Injects a collector on first call and returns accumulated logs since.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        clear: z
          .boolean()
          .optional()
          .describe("Clear the log buffer after reading (default false)"),
      },
      outputSchema: {
        logs: z.string(),
      },
    },
    async ({ browserId, clear }) => {
      try {
        const expression = `
          (function() {
            if (!window.__hubcodeLogs) {
              window.__hubcodeLogs = [];
              const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
              ['log','warn','error','info'].forEach(level => {
                console[level] = function(...args) {
                  window.__hubcodeLogs.push({ level, message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '), ts: Date.now() });
                  if (window.__hubcodeLogs.length > 200) window.__hubcodeLogs.shift();
                  orig[level].apply(console, args);
                };
              });
              window.addEventListener('error', e => {
                window.__hubcodeLogs.push({ level: 'error', message: e.message + (e.filename ? ' at ' + e.filename + ':' + e.lineno : ''), ts: Date.now() });
              });
              window.addEventListener('unhandledrejection', e => {
                window.__hubcodeLogs.push({ level: 'error', message: 'Unhandled rejection: ' + String(e.reason), ts: Date.now() });
              });
            }
            const logs = JSON.stringify(window.__hubcodeLogs);
            ${clear ? "window.__hubcodeLogs = [];" : ""}
            return logs;
          })()
        `;
        const evalResult = await browserManager.evaluate(browserId, expression);
        return {
          content: [],
          structuredContent: ensureValidJson({ logs: evalResult.result }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to get console logs");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ logs: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_network_requests",
    {
      title: "Get network requests",
      description:
        "Get a list of network requests made by the page (XHR, fetch, resources). Shows URL, method, status code, and response type. Useful for debugging API calls, verifying endpoints, checking for failed requests. Injects a collector on first call.",
      inputSchema: {
        browserId: z.string().describe("ID of the browser instance"),
        clear: z
          .boolean()
          .optional()
          .describe("Clear the request buffer after reading (default false)"),
      },
      outputSchema: {
        requests: z.string(),
      },
    },
    async ({ browserId, clear }) => {
      try {
        const expression = `
          (function() {
            if (!window.__hubcodeNetRequests) {
              window.__hubcodeNetRequests = [];
              const origFetch = window.fetch;
              window.fetch = async function(...args) {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                const method = args[1]?.method || 'GET';
                const entry = { type: 'fetch', method, url, status: 0, ts: Date.now() };
                window.__hubcodeNetRequests.push(entry);
                if (window.__hubcodeNetRequests.length > 100) window.__hubcodeNetRequests.shift();
                try {
                  const res = await origFetch.apply(this, args);
                  entry.status = res.status;
                  return res;
                } catch (err) {
                  entry.status = 0;
                  entry.error = String(err);
                  throw err;
                }
              };
              const origXHROpen = XMLHttpRequest.prototype.open;
              const origXHRSend = XMLHttpRequest.prototype.send;
              XMLHttpRequest.prototype.open = function(method, url) {
                this.__hubcodeReq = { type: 'xhr', method, url: String(url), status: 0, ts: Date.now() };
                return origXHROpen.apply(this, arguments);
              };
              XMLHttpRequest.prototype.send = function() {
                if (this.__hubcodeReq) {
                  window.__hubcodeNetRequests.push(this.__hubcodeReq);
                  if (window.__hubcodeNetRequests.length > 100) window.__hubcodeNetRequests.shift();
                  const req = this.__hubcodeReq;
                  this.addEventListener('loadend', () => { req.status = this.status; });
                }
                return origXHRSend.apply(this, arguments);
              };
            }
            const reqs = JSON.stringify(window.__hubcodeNetRequests);
            ${clear ? "window.__hubcodeNetRequests = [];" : ""}
            return reqs;
          })()
        `;
        const evalResult = await browserManager.evaluate(browserId, expression);
        return {
          content: [],
          structuredContent: ensureValidJson({ requests: evalResult.result }),
        };
      } catch (error) {
        logger.error({ error, browserId }, "Failed to get network requests");
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          structuredContent: ensureValidJson({ requests: "" }),
        };
      }
    },
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Take screenshot",
      description:
        "Capture a screenshot of the current browser page as an image. Only use this when you specifically need a visual representation (e.g. checking layout, CSS, visual regression). For reading text content, use browser_get_text instead. For checking specific values, use browser_evaluate instead.",
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
      description: "Close the browser tab and release its resources.",
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
