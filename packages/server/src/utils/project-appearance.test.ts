import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cacheProjectFavicon,
  readCachedProjectFavicon,
  removeCachedProjectFavicon,
  serializeProjectAppearanceMutation,
} from "./project-appearance.js";

const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
]);

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function listen(server: Server, path: string): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  return `http://127.0.0.1:${address.port}${path}`;
}

async function serve(body: Buffer): Promise<string> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": body.length });
    response.end(body);
  });
  return listen(server, "/favicon");
}

async function serveWebsite(): Promise<string> {
  const html = Buffer.from(
    `<html><head><link rel="icon" type="image/png" href="/icon.png"></head><body>${"x".repeat(70 * 1024)}</body></html>`,
  );
  const server: Server = createServer((request, response) => {
    const body = request.url === "/icon.png" ? PNG_1X1 : html;
    const contentType = request.url === "/icon.png" ? "image/png" : "text/html";
    response.writeHead(200, { "content-length": body.length, "content-type": contentType });
    response.end(body);
  });
  return listen(server, "/");
}

async function paseoHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-project-icon-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("project favicon cache", () => {
  it("serializes appearance mutations for one project", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = serializeProjectAppearanceMutation("project-a", async () => {
      order.push("first:start");
      markFirstStarted();
      await firstGate;
      order.push("first:end");
    });
    await firstStarted;
    const second = serializeProjectAppearanceMutation("project-a", async () => {
      order.push("second");
    });

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("downloads, validates, and reads a cached PNG", async () => {
    const home = await paseoHome();
    const icon = await cacheProjectFavicon({
      paseoHome: home,
      projectId: "project-a",
      url: await serve(PNG_1X1),
    });

    expect(icon).toEqual({ data: PNG_1X1.toString("base64"), mimeType: "image/png" });
    await expect(
      readCachedProjectFavicon({ paseoHome: home, projectId: "project-a" }),
    ).resolves.toEqual(icon);
  });

  it("removes a cached icon", async () => {
    const home = await paseoHome();
    await cacheProjectFavicon({
      paseoHome: home,
      projectId: "project-a",
      url: await serve(PNG_1X1),
    });

    await removeCachedProjectFavicon({ paseoHome: home, projectId: "project-a" });

    await expect(
      readCachedProjectFavicon({ paseoHome: home, projectId: "project-a" }),
    ).resolves.toBeNull();
  });

  it("discovers an icon from a website URL", async () => {
    const icon = await cacheProjectFavicon({
      paseoHome: await paseoHome(),
      projectId: "project-a",
      url: await serveWebsite(),
    });

    expect(icon).toEqual({ data: PNG_1X1.toString("base64"), mimeType: "image/png" });
  });

  it("rejects data that is not an image", async () => {
    await expect(
      cacheProjectFavicon({
        paseoHome: await paseoHome(),
        projectId: "project-a",
        url: await serve(Buffer.from("not an image")),
      }),
    ).rejects.toThrow("Unsupported or invalid icon file");
  });

  it("accepts valid icons larger than 64 KB", async () => {
    const largePng = Buffer.concat([PNG_1X1, Buffer.alloc(70 * 1024)]);
    const icon = await cacheProjectFavicon({
      paseoHome: await paseoHome(),
      projectId: "project-a",
      url: await serve(largePng),
    });

    expect(icon.data).toBe(largePng.toString("base64"));
  });

  it("rejects files larger than 512 KB", async () => {
    await expect(
      cacheProjectFavicon({
        paseoHome: await paseoHome(),
        projectId: "project-a",
        url: await serve(Buffer.alloc(512 * 1024 + 1)),
      }),
    ).rejects.toThrow("512 KB or smaller");
  });
});
