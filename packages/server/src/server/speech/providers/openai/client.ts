import { OpenAI } from "openai";
import { OpenAiSpeechEndpointSchema, type OpenAiSpeechEndpointConfig } from "./config.js";

export function createOpenAiSpeechClient(
  config: OpenAiSpeechEndpointConfig,
  fetch?: typeof globalThis.fetch,
): OpenAI {
  const endpoint = OpenAiSpeechEndpointSchema.parse({
    auth: config.auth,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  });
  if (endpoint.auth === "none") {
    return new OpenAI({
      // The SDK requires a credential at construction. This sentinel never goes
      // on the wire: null headers explicitly remove SDK authentication.
      apiKey: "unused",
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: endpoint.baseUrl,
      defaultHeaders: { Authorization: null, "api-key": null },
      fetchOptions: { redirect: "error" },
      maxRetries: 0,
      fetch,
    });
  }
  if (!endpoint.apiKey) {
    throw new Error(
      "OpenAI speech requires an apiKey or explicit auth: none with a loopback baseUrl",
    );
  }
  return new OpenAI({
    apiKey: endpoint.apiKey,
    ...(endpoint.baseUrl ? { baseURL: endpoint.baseUrl } : {}),
    fetch,
  });
}
