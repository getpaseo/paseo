import { isSessionNotFoundError } from "@opencode/client";
import { OpenCodeHttpError } from "../http-error.js";

export async function validateOpenCodeResponse(
  request: RequestInfo | URL,
  response: Response,
): Promise<Response> {
  const contentType = response.headers.get("content-type");
  const html = contentType?.includes("text/html") ?? false;
  if (response.ok && !html) return response;

  // The SDK needs the original body to decode the provider's missing-session error.
  if (response.status === 404 && !html && contentType?.includes("application/json")) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (isSessionNotFoundError(body)) return response;
  }

  const url = request instanceof Request ? request.url : String(request);
  throw new OpenCodeHttpError(new URL(url).pathname, response.status, html);
}
