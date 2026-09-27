import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const FIXTURE_USERNAME = "user@example.com";
export const FIXTURE_PASSWORD = "correct-horse-password";
const AUTH_COOKIE = "verify_auth=1";

export interface VerifyFixtureApp {
  url: string;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: unknown) => {
      body += String(chunk);
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function isAuthenticated(request: IncomingMessage): boolean {
  return (request.headers.cookie ?? "").split(";").some((part) => part.trim() === AUTH_COOKIE);
}

function loginPage(error: string | null): string {
  return [
    "<!doctype html><html><head><title>Sign in</title></head><body>",
    "<h1>Sign in</h1>",
    error ? `<p role="alert">${error}</p>` : "",
    '<form method="post" action="/login">',
    '<label for="email">Email</label>',
    '<input id="email" name="email" type="email" aria-label="Email" />',
    '<label for="password">Password</label>',
    '<input id="password" name="password" type="password" aria-label="Password" />',
    '<button type="submit">Sign in</button>',
    "</form></body></html>",
  ].join("");
}

function reportPage(caseId: string): string {
  return [
    "<!doctype html><html><head><title>Case</title></head><body>",
    "<h1>Current Report</h1>",
    `<p>Case ${caseId}</p>`,
    "</body></html>",
  ].join("");
}

function noisyPage(): string {
  return [
    "<!doctype html><html><head><title>Noisy</title></head><body>",
    "<h1>Noisy page</h1>",
    "<script>console.error('boom');fetch('/api/missing').catch(() => {});</script>",
    "</body></html>",
  ].join("");
}

function interactionPage(): string {
  return [
    "<!doctype html><html><head><title>Interaction</title></head>",
    '<body style="height: 2400px; margin: 0">',
    '<button id="click-target" onclick="document.body.dataset.clicked = \'yes\'" style="position:absolute;left:16px;top:16px">Click target</button>',
    "<button onclick=\"window.open('/login', 'login')\" style=\"position:absolute;left:500px;top:16px\">Open sign in</button>",
    '<div id="hover-target" onmouseenter="document.body.dataset.hovered = \'yes\'" style="position:absolute;left:220px;top:16px;width:140px;height:48px">Hover target</div>',
    '<div id="drag-source" onpointerdown="document.body.dataset.dragging = \'yes\'" style="position:absolute;left:16px;top:120px;width:100px;height:48px">Drag source</div>',
    '<div id="drag-target" onpointerup="if (document.body.dataset.dragging === \'yes\') document.body.dataset.dragged = \'yes\'" style="position:absolute;left:300px;top:120px;width:100px;height:48px">Drag target</div>',
    '<div style="height: 2200px"></div>',
    "</body></html>",
  ].join("");
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function redirect(response: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string> = { location };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  response.writeHead(302, headers);
  response.end();
}

export function startVerifyFixtureApp(): Promise<VerifyFixtureApp> {
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.writableEnded) {
        response.writeHead(500);
        response.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
              } else {
                resolveClose();
              }
            });
          }),
      });
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/login" && request.method === "GET") {
    if (isAuthenticated(request)) {
      redirect(response, "/report");
      return;
    }
    sendHtml(response, 200, loginPage(null));
    return;
  }
  if (url.pathname === "/login" && request.method === "POST") {
    const body = new URLSearchParams(await readBody(request));
    if (body.get("email") === FIXTURE_USERNAME && body.get("password") === FIXTURE_PASSWORD) {
      redirect(response, "/report", `${AUTH_COOKIE}; Path=/; HttpOnly; Max-Age=3600`);
      return;
    }
    sendHtml(response, 200, loginPage("Invalid credentials"));
    return;
  }
  if (url.pathname === "/report" && request.method === "GET") {
    if (!isAuthenticated(request)) {
      redirect(response, "/login");
      return;
    }
    sendHtml(response, 200, reportPage(url.searchParams.get("case") ?? "unknown"));
    return;
  }
  if (url.pathname === "/noisy" && request.method === "GET") {
    sendHtml(response, 200, noisyPage());
    return;
  }
  if (url.pathname === "/interaction" && request.method === "GET") {
    sendHtml(response, 200, interactionPage());
    return;
  }
  if (url.pathname === "/api/missing") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (url.pathname === "/api/data") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
}
