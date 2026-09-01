import { describe, expect, it } from "vitest";
import {
  parseNewWorkspaceDeepLink,
  parseNewWorkspaceDeepLinkFromArgv,
  redactNewWorkspacePromptFromArgv,
} from "./new-workspace-navigation";

describe("desktop new workspace navigation", () => {
  it("routes prompt query parameters", () => {
    expect(parseNewWorkspaceDeepLink("paseo://new?q=Fix%20it%20%26%20test%20it")).toBe(
      "/new?q=Fix%20it%20%26%20test%20it",
    );
  });

  it("preserves existing new-workspace query parameters", () => {
    expect(
      parseNewWorkspaceDeepLink(
        "paseo://new?serverId=host-1&dir=%2Frepo&name=Repo&projectId=project-1&draftId=draft-1&q=Start",
      ),
    ).toBe(
      "/new?serverId=host-1&dir=%2Frepo&name=Repo&projectId=project-1&draftId=draft-1&q=Start",
    );
  });

  it("finds the deep link in desktop launch arguments", () => {
    expect(
      parseNewWorkspaceDeepLinkFromArgv([
        "/Applications/Paseo.app/Contents/MacOS/Paseo",
        "--no-sandbox",
        "paseo://new?q=Start",
      ]),
    ).toBe("/new?q=Start");
  });

  it("rejects unrelated and nested custom-scheme URLs", () => {
    for (const input of [
      "https://paseo.sh/new?q=Start",
      "paseo://settings",
      "paseo://new/extra?q=Start",
      "not a URL",
    ]) {
      expect(parseNewWorkspaceDeepLink(input)).toBeNull();
    }
  });

  it("redacts prompt query parameters before launch arguments are logged", () => {
    expect(
      redactNewWorkspacePromptFromArgv([
        "--no-sandbox",
        "paseo://new?serverId=host-1&q=private%20prompt&source=integration",
      ]),
    ).toEqual(["--no-sandbox", "paseo://new?serverId=host-1&q=REDACTED&source=integration"]);
  });
});
