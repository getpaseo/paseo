import { describe, expect, it } from "vitest";
import type { ServiceUrlBehavior } from "@/hooks/use-settings";
import { routeServiceUrl, type ServiceUrlAskResult } from "./open-service-url";

const URL = "http://localhost:3000";

async function route(behavior: ServiceUrlBehavior, askResult: ServiceUrlAskResult = "external") {
  const calls: string[] = [];
  await routeServiceUrl({
    url: URL,
    behavior,
    askHowToOpen: async () => {
      calls.push("ask");
      return askResult;
    },
    openInApp: (url, location) => {
      calls.push(`in-app:${location}:${url}`);
    },
    openExternal: async (url) => {
      calls.push(`external:${url}`);
    },
  });
  return calls;
}

describe("routeServiceUrl", () => {
  it("opens in the focused pane for In Paseo", async () => {
    expect(await route("in-app")).toEqual([`in-app:focused:${URL}`]);
  });

  it("opens beside the user's work for In Paseo on the side", async () => {
    expect(await route("in-app-side")).toEqual([`in-app:side:${URL}`]);
  });

  it("opens the system browser for External browser", async () => {
    expect(await route("external")).toEqual([`external:${URL}`]);
  });

  it("opens in the focused pane when Ask resolves to In Paseo", async () => {
    expect(await route("ask", "in-app")).toEqual(["ask", `in-app:focused:${URL}`]);
  });

  it("opens the system browser when Ask resolves to External browser", async () => {
    expect(await route("ask", "external")).toEqual(["ask", `external:${URL}`]);
  });
});
