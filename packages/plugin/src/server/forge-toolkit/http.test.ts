import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ForgeAuthenticationError, ForgeCommandError } from "../../forge.js";
import { buildUrl, createForgeHttpClient, resolveTokenFromEnv } from "./http.js";

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function client(
  respond: (call: StubCall) => { status: number; body: string },
  overrides: Partial<Parameters<typeof createForgeHttpClient>[0]> = {},
) {
  const calls: StubCall[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: StubCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    const { status, body } = respond(call);
    // A 204 must be constructed with a null body.
    return Promise.resolve(new Response(body === "" ? null : body, { status }));
  }) as typeof fetch;
  return {
    calls,
    http: createForgeHttpClient({
      brand: "Acme",
      baseUrl: "https://acme.test/api/v5",
      resolveToken: () => Promise.resolve("token-123"),
      fetchImpl,
      ...overrides,
    }),
  };
}

describe("forge toolkit REST transport", () => {
  it("sends a bearer token and parses the body through the schema", async () => {
    const { http, calls } = client(() => ({ status: 200, body: '{"number":7}' }));

    const result = await http.request({
      cwd: "/repo",
      path: "/repos/acme/app/pulls/7",
      schema: z.object({ number: z.number() }),
    });

    expect(result).toEqual({ number: 7 });
    expect(calls[0]?.url).toBe("https://acme.test/api/v5/repos/acme/app/pulls/7");
    expect(calls[0]?.headers.authorization).toBe("Bearer token-123");
  });

  it("reports an unconfigured token as an authentication failure", async () => {
    const { http } = client(() => ({ status: 200, body: "{}" }), {
      resolveToken: () => Promise.resolve(null),
    });

    await expect(
      http.request({ cwd: "/repo", path: "/user", schema: z.object({}) }),
    ).rejects.toBeInstanceOf(ForgeAuthenticationError);
  });

  it("classifies 401 as an authentication failure and keeps the body as stderr", async () => {
    const { http } = client(() => ({ status: 401, body: "bad credentials" }));

    const error = await http
      .request({ cwd: "/repo", path: "/user", schema: z.object({}) })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForgeAuthenticationError);
    expect((error as ForgeAuthenticationError).stderr).toBe("bad credentials");
  });

  it("classifies other failures as command errors and redacts marked query values", async () => {
    const { http } = client(() => ({ status: 404, body: "not found" }));

    const error = await http
      .request({
        cwd: "/repo",
        path: "/search/issues",
        query: { q: "secret term", page: 1 },
        redactQueryKeys: ["q"],
        schema: z.object({}),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForgeCommandError);
    const commandError = error as ForgeCommandError;
    expect(commandError.exitCode).toBe(404);
    expect(commandError.stderr).toBe("not found");
    expect(commandError.args).toEqual(["GET", "/search/issues?q=<redacted>&page=1"]);
  });

  it("fails a schema mismatch as a command error rather than returning unvalidated data", async () => {
    const { http } = client(() => ({ status: 200, body: '{"number":"seven"}' }));

    const error = await http
      .request({ cwd: "/repo", path: "/pulls/7", schema: z.object({ number: z.number() }) })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForgeCommandError);
    expect((error as ForgeCommandError).stderr).toContain("did not match the expected schema");
  });

  it("parses an empty body as undefined so 204 endpoints can declare it", async () => {
    const { http } = client(() => ({ status: 204, body: "" }));

    await expect(
      http.request({ cwd: "/repo", path: "/pulls/7/merge", method: "PUT", schema: z.undefined() }),
    ).resolves.toBeUndefined();
  });

  it("lets a forge move the token off the Authorization header", async () => {
    const { http, calls } = client(() => ({ status: 200, body: "{}" }), {
      applyToken: (token, request) => {
        request.url.searchParams.set("access_token", token);
      },
    });

    await http.request({ cwd: "/repo", path: "/user", schema: z.object({}) });

    expect(calls[0]?.url).toBe("https://acme.test/api/v5/user?access_token=token-123");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("serializes a JSON body and sets the content type", async () => {
    const { http, calls } = client(() => ({ status: 201, body: '{"id":1}' }));

    await http.request({
      cwd: "/repo",
      path: "/pulls",
      method: "POST",
      body: { title: "Fix" },
      schema: z.object({ id: z.number() }),
    });

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe('{"title":"Fix"}');
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("exposes response headers through send so a caller can read pagination totals", async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response("[]", { status: 200, headers: { total_count: "42" } }));
    }) as typeof fetch;
    const http = createForgeHttpClient({
      brand: "Acme",
      baseUrl: "https://acme.test/api/v5",
      resolveToken: () => Promise.resolve("token-123"),
      fetchImpl,
    });

    const response = await http.send({ cwd: "/repo", path: "/pulls" });

    expect(response.headers.get("total_count")).toBe("42");
  });

  it("turns an aborted request into a command error naming the timeout", async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const http = createForgeHttpClient({
      brand: "Acme",
      baseUrl: "https://acme.test/api/v5",
      resolveToken: () => Promise.resolve("token-123"),
      timeoutMs: 5,
      fetchImpl,
    });

    const error = await http
      .request({ cwd: "/repo", path: "/user", schema: z.object({}) })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForgeCommandError);
    expect((error as ForgeCommandError).stderr).toContain("timed out after 5ms");
  });
});

describe("buildUrl", () => {
  it("keeps the API root path when joining a leading-slash path", () => {
    expect(buildUrl("https://acme.test/api/v5", "/repos/a/b").toString()).toBe(
      "https://acme.test/api/v5/repos/a/b",
    );
  });

  it("drops null and undefined query values", () => {
    expect(
      buildUrl("https://acme.test/api/v5", "search", {
        q: "x",
        page: undefined,
        state: null,
      }).toString(),
    ).toBe("https://acme.test/api/v5/search?q=x");
  });
});

describe("resolveTokenFromEnv", () => {
  it("returns the first non-empty variable and null when none are set", () => {
    expect(resolveTokenFromEnv(["A", "B"], { A: "  ", B: " token " })).toBe("token");
    expect(resolveTokenFromEnv(["A", "B"], { A: "", B: undefined })).toBeNull();
  });
});
