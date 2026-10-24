import { getE2EDaemonPort } from "./daemon-port";
import { hideDeveloperToasts } from "../developer-ui.mjs";
import type { Browser, BrowserContext, Page, WebSocketRoute } from "@playwright/test";
export interface DragTabAfterInput {
  page: Page;
  sourceTestId: string;
  targetTestId: string;
}
export async function dragTabAfter({
  page,
  sourceTestId,
  targetTestId,
}: DragTabAfterInput): Promise<void> {
  const source = await page.getByTestId(sourceTestId).filter({ visible: true }).boundingBox();
  const target = await page.getByTestId(targetTestId).filter({ visible: true }).boundingBox();
  if (!source || !target) throw new Error("Expected visible tabs to drag");
  await page.mouse.move(source.x + 20, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + 32, source.y + source.height / 2);
  await page.mouse.move(target.x + target.width - 8, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
}
export interface IndependentCompactClientInput {
  browser: Browser;
  page: Page;
}
export interface IndependentCompactClient {
  context: BrowserContext;
  page: Page;
  setOffline: (input: { offline: boolean }) => Promise<void>;
}
export async function openIndependentCompactClient({
  browser,
  page,
}: IndependentCompactClientInput): Promise<IndependentCompactClient> {
  const storage = await page.context().storageState();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: {
      cookies: [],
      origins: storage.origins.map((origin) => ({
        origin: origin.origin,
        localStorage: origin.localStorage.filter((entry) =>
          ["@paseo:e2e", "@paseo:daemon-registry", "@paseo:create-agent-preferences"].includes(
            entry.name,
          ),
        ),
      })),
    },
  });
  try {
    const compact = await context.newPage();
    await hideDeveloperToasts(compact);
    await compact.route(/:(6767)\b/, (route) => route.abort());
    await compact.routeWebSocket(/:(6767)\b/, (socket) => socket.close());
    let offline = false;
    const connections: WebSocketRoute[] = [];
    await compact.routeWebSocket(
      (url) => url.port === String(getE2EDaemonPort()),
      (socket) => {
        if (offline) {
          void socket.close();
          return;
        }
        const server = socket.connectToServer();
        connections.push(socket, server);
      },
    );
    await compact.goto(page.url());
    return {
      context,
      page: compact,
      setOffline: async (input) => {
        offline = input.offline;
        if (offline) await Promise.all(connections.splice(0).map((socket) => socket.close()));
      },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
