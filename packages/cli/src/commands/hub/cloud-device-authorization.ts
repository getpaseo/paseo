import { z } from "zod";

const START_TIMEOUT_MS = 15_000;
const activationUrlSchema = z.url({ protocol: /^https?$/u });

const authorizationSchema = z.object({
  deviceCode: z.string().min(32),
  userCode: z.string().min(1),
  verificationUri: activationUrlSchema,
  verificationUriComplete: activationUrlSchema,
  expiresAt: z.string().datetime(),
  interval: z.number().int().min(5),
});

const pollSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), interval: z.number().int().min(5) }),
  z.object({ status: z.literal("slow_down"), interval: z.number().int().min(5) }),
  z.object({
    status: z.literal("approved"),
    interval: z.number().int().min(5),
    enrollmentToken: z.string().min(32),
  }),
  z.object({ status: z.literal("denied"), interval: z.number().int().min(5) }),
  z.object({ status: z.literal("expired"), interval: z.number().int().min(5) }),
  z.object({ status: z.literal("enrolled"), interval: z.number().int().min(5) }),
  z.object({ status: z.literal("retry_later") }),
]);

export type DeviceAuthorization = z.infer<typeof authorizationSchema>;
export type DeviceAuthorizationPoll = z.infer<typeof pollSchema>;

export interface CloudDeviceAuthorization {
  start(hubUrl: string, displayName: string): Promise<DeviceAuthorization>;
  poll(
    hubUrl: string,
    deviceCode: string,
    timeoutMilliseconds: number,
  ): Promise<DeviceAuthorizationPoll>;
}

export class CloudDeviceAuthorizationClient implements CloudDeviceAuthorization {
  constructor(private readonly startTimeoutMilliseconds = START_TIMEOUT_MS) {}

  async start(hubUrl: string, displayName: string): Promise<DeviceAuthorization> {
    const signal = AbortSignal.timeout(this.startTimeoutMilliseconds);
    try {
      const response = await fetch(endpoint(hubUrl, "/api/device-authorizations/"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
        signal,
      });
      if (!response.ok) throw new Error(`Cloud registration failed (${response.status})`);
      return authorizationSchema.parse(await response.json());
    } catch (error) {
      if (signal.aborted) {
        throw new Error("Cloud registration start timed out", { cause: error });
      }
      throw error;
    }
  }

  async poll(
    hubUrl: string,
    deviceCode: string,
    timeoutMilliseconds: number,
  ): Promise<DeviceAuthorizationPoll> {
    const signal = AbortSignal.timeout(timeoutMilliseconds);
    let response: Response;
    try {
      response = await fetch(endpoint(hubUrl, "/api/device-authorizations/poll"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
        signal,
      });
    } catch {
      return { status: "retry_later" };
    }
    if ([408, 425, 429].includes(response.status) || response.status >= 500) {
      return { status: "retry_later" };
    }
    if (!response.ok) throw new Error(`Cloud registration poll failed (${response.status})`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (signal.aborted || error instanceof TypeError) return { status: "retry_later" };
      throw error;
    }
    return pollSchema.parse(body);
  }
}

function endpoint(hubUrl: string, pathname: string): string {
  const url = new URL(hubUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Hub URL must be an HTTP or HTTPS origin without credentials or a query");
  }
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${pathname}`;
  return url.toString();
}
