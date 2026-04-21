import http from "node:http";

import { resolveDaemonTarget } from "../../utils/client.js";

function requestText(
  host: string,
  method: "GET" | "POST",
  pathname: string,
  body?: Record<string, unknown>,
): Promise<string> {
  const target = resolveDaemonTarget(host);
  const payload = body ? JSON.stringify(body) : null;

  return new Promise<string>((resolve, reject) => {
    const baseOptions =
      target.type === "tcp"
        ? {
            host: new URL(target.url.replace(/^ws:/u, "http:")).hostname,
            port: Number(new URL(target.url.replace(/^ws:/u, "http:")).port || 80),
          }
        : {
            socketPath: target.socketPath,
          };

    const req = http.request(
      {
        ...baseOptions,
        path: pathname,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload, "utf8")),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(text || `Daemon request failed with status ${res.statusCode}`));
            return;
          }
          resolve(text);
        });
      },
    );

    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

export async function getDaemonJson<T>(host: string, pathname: string): Promise<T> {
  const raw = await requestText(host, "GET", pathname);
  return JSON.parse(raw) as T;
}

export async function postDaemonJson<T>(
  host: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<T> {
  const raw = await requestText(host, "POST", pathname, body);
  return JSON.parse(raw) as T;
}
