import type { z } from "zod";
import { HubCommandError } from "../../error.js";
import { hubRequestFailure } from "./problem.js";

interface HubRequest<T> {
  origin: string;
  path: string;
  method: "GET" | "POST";
  apiKey?: string;
  body?: unknown;
  successStatus: number;
  schema: z.ZodType<T>;
  timeoutMilliseconds?: number;
  failureMessage: string;
}

export async function requestHub<T>(input: HubRequest<T>): Promise<T> {
  const signal = AbortSignal.timeout(input.timeoutMilliseconds ?? 15_000);
  let response: Response;
  try {
    response = await fetch(`${input.origin}${input.path}`, {
      method: input.method,
      headers: {
        ...(input.apiKey === undefined ? {} : { authorization: `Bearer ${input.apiKey}` }),
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal,
    });
  } catch {
    throw new HubCommandError(
      "HUB_NETWORK_ERROR",
      `Could not reach Paseo Hub at ${input.origin}. Check the Hub URL and network connection.`,
    );
  }
  if (response.status !== input.successStatus) {
    throw await hubRequestFailure(response, input.failureMessage, input.apiKey);
  }
  try {
    return input.schema.parse(await response.json());
  } catch {
    throw new HubCommandError("HUB_INVALID_RESPONSE", "Hub returned a malformed response.");
  }
}
