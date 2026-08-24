import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import { importProjectIconFromUrl } from "./import-project-icon";

const IMAGE = new Uint8Array([1, 2, 3, 4]);

function response(body: BodyInit, contentType: string): Response {
  return new Response(body, { headers: { "content-type": contentType } });
}

describe("project icon URL import", () => {
  it("turns a direct image URL into an upload payload", async () => {
    const source = await importProjectIconFromUrl("https://example.com/icon.png", async () =>
      response(IMAGE.buffer, "image/png"),
    );

    expect(source).toEqual({ type: "upload", data: Buffer.from(IMAGE).toString("base64") });
  });

  it("fetches a website icon on the client and returns an upload payload", async () => {
    const requested: string[] = [];
    const source = await importProjectIconFromUrl("https://example.com", async (input) => {
      const url = input.toString();
      requested.push(url);
      if (url === "https://example.com/") {
        return response('<link rel="icon" href="/brand.png">', "text/html");
      }
      return response(IMAGE.buffer, "image/png");
    });

    expect(requested).toEqual(["https://example.com/", "https://example.com/brand.png"]);
    expect(source.type).toBe("upload");
  });

  it("rejects non-HTTP URLs without fetching", async () => {
    let fetched = false;

    await expect(
      importProjectIconFromUrl("file:///etc/passwd", async () => {
        fetched = true;
        return response(IMAGE.buffer, "image/png");
      }),
    ).rejects.toThrow("URL must use HTTP or HTTPS without credentials");
    expect(fetched).toBe(false);
  });
});
