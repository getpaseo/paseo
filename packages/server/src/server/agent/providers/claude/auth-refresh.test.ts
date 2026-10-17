import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyAwsAuthRefreshFailure,
  readClaudeAuthRefreshSettingsSync,
} from "./auth-refresh.js";

describe("readClaudeAuthRefreshSettingsSync", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-refresh-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty object when settings.json does not exist", () => {
    const result = readClaudeAuthRefreshSettingsSync(tempDir);
    expect(result).toEqual({});
  });

  it("returns empty object when settings.json is not valid JSON", () => {
    fs.writeFileSync(path.join(tempDir, "settings.json"), "invalid json {");
    const result = readClaudeAuthRefreshSettingsSync(tempDir);
    expect(result).toEqual({});
  });

  it("returns empty object when settings.json is not an object", () => {
    fs.writeFileSync(path.join(tempDir, "settings.json"), JSON.stringify(["item"]));
    const result = readClaudeAuthRefreshSettingsSync(tempDir);
    expect(result).toEqual({});
  });

  it("returns empty object when awsAuthRefresh is empty or missing", () => {
    fs.writeFileSync(path.join(tempDir, "settings.json"), JSON.stringify({ model: "claude-3-5" }));
    const result = readClaudeAuthRefreshSettingsSync(tempDir);
    expect(result).toEqual({});

    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({ awsAuthRefresh: "   " }),
    );
    expect(readClaudeAuthRefreshSettingsSync(tempDir)).toEqual({});
  });

  it("extracts awsAuthRefresh command when configured", () => {
    const cmd = "aws sso login --profile bedrock --no-browser --use-device-code";
    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({ awsAuthRefresh: `  ${cmd}  ` }),
    );
    const result = readClaudeAuthRefreshSettingsSync(tempDir);
    expect(result).toEqual({ awsAuthRefresh: cmd });
  });

  it("extracts awsAuthRefresh command and env block", () => {
    const cmd = "aws sso login --profile bedrock";
    fs.writeFileSync(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        awsAuthRefresh: cmd,
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "bedrock",
          AWS_REGION: "us-east-1",
          NUMERIC_VALUE: 123,
        },
      }),
    );
    const result = readClaudeAuthRefreshSettingsSync(tempDir);
    expect(result).toEqual({
      awsAuthRefresh: cmd,
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "bedrock",
        AWS_REGION: "us-east-1",
      },
    });
  });
});

describe("classifyAwsAuthRefreshFailure", () => {
  const refreshCmd = "aws sso login --profile bedrock --no-browser --use-device-code";

  it("never matches if awsAuthRefresh is not configured", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "AWS auth refresh timed out after 180000ms",
        awsAuthRefresh: undefined,
      }),
    ).toBe(false);

    expect(
      classifyAwsAuthRefreshFailure({
        message: "The security token included in the request is expired",
        recentStderr: "ExpiredToken: token expired",
        awsAuthRefresh: "",
      }),
    ).toBe(false);

    expect(
      classifyAwsAuthRefreshFailure({
        message: "The security token included in the request is expired",
        recentStderr: "ExpiredToken: token expired",
        awsAuthRefresh: null,
      }),
    ).toBe(false);
  });

  it("matches 'AWS auth refresh timed out'", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "Command failed: AWS auth refresh timed out after 180s",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(true);
  });

  it("matches 'Error running awsAuthRefresh'", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "Error running awsAuthRefresh: exit code 1",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(true);
  });

  it("matches ExpiredToken in message", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "Bedrock runtime error: ExpiredTokenException",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(true);
  });

  it("matches expired token in message case-insensitively", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "Encountered expired token while invoking model",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(true);
  });

  it("matches expiration patterns in recentStderr", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "Claude run failed with code 1",
        recentStderr: "Stderr:\nAn error occurred (ExpiredToken) when calling InvokeModel",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(true);

    expect(
      classifyAwsAuthRefreshFailure({
        message: "Claude run failed",
        recentStderr: "The security token included in the request is expired",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(true);
  });

  it("does not match unrelated error messages", () => {
    expect(
      classifyAwsAuthRefreshFailure({
        message: "Connection refused 127.0.0.1:8080",
        recentStderr: "ECONNREFUSED",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(false);

    expect(
      classifyAwsAuthRefreshFailure({
        message: "Rate limit exceeded. Please retry in 30 seconds.",
        awsAuthRefresh: refreshCmd,
      }),
    ).toBe(false);
  });
});
