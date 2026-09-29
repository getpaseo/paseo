import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTypeSafeApiKey, parseChoiceAnswer, TypeSafeSystemOneClient } from "./jev-client.js";

const originalApiKey = process.env.TYPESAFE_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.TYPESAFE_API_KEY;
  } else {
    process.env.TYPESAFE_API_KEY = originalApiKey;
  }
});

describe("loadTypeSafeApiKey", () => {
  it("loads an exported key from the configured private env file", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const directory = await mkdtemp(join(tmpdir(), "paseo-typesafe-"));
    const envFile = join(directory, "env");
    await writeFile(envFile, 'export TYPESAFE_API_KEY="test-key"\n', { mode: 0o600 });

    try {
      await expect(loadTypeSafeApiKey(envFile)).resolves.toBe("test-key");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("parseChoiceAnswer", () => {
  it("accepts a complete normalized winner", () => {
    expect(
      parseChoiceAnswer(
        {
          choice: "CLICK",
          confidence: 0.8,
          probabilities: { CLICK: 0.75, DONE: 0.25 },
        },
        ["CLICK", "DONE"],
      ),
    ).toMatchObject({ choice: "CLICK", confidence: 0.8 });
  });

  it("rejects malformed probabilities before an action can execute", () => {
    expect(() =>
      parseChoiceAnswer(
        {
          choice: "CLICK",
          confidence: 0.8,
          probabilities: { CLICK: 0.2, DONE: 0.8 },
        },
        ["CLICK", "DONE"],
      ),
    ).toThrow("invalid choice");
  });
});

describe("TypeSafeSystemOneClient", () => {
  it("sends the System One contract without exposing the key in errors", async () => {
    let authorization = "";
    let endpoint = "";
    const client = new TypeSafeSystemOneClient({
      apiKey: "private-key",
      endpoint: "https://self-hosted.example/systemone",
      fetchImpl: async (_input, init) => {
        endpoint = String(_input);
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              operation: {
                choice: "DONE",
                confidence: 1,
                probabilities: { DONE: 1 },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const response = await client.decide({
      state: { goal: "Verify the page" },
      questions: {
        operation: { type: "choice", criteria: { DONE: "Complete" } },
      },
    });

    expect(authorization).toBe("Bearer private-key");
    expect(endpoint).toBe("https://self-hosted.example/systemone");
    expect(response.model).toBe("jev-latest");
  });
});
