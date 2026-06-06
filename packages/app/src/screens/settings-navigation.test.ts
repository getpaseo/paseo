import { describe, expect, it } from "vitest";
import {
  resolveCompactSettingsDetailBackDestination,
  resolveSettingsBackDestination,
} from "./settings-navigation";

describe("resolveSettingsBackDestination", () => {
  it("prefers the entry return route", () => {
    expect(
      resolveSettingsBackDestination({
        entryReturnPath: "/h/srv-1/workspace/repo",
        anyOnlineServerId: "srv-2",
      }),
    ).toEqual({
      kind: "entry-route",
      route: "/h/srv-1/workspace/repo",
    });
  });

  it("falls back to an online host open-project route", () => {
    expect(
      resolveSettingsBackDestination({
        entryReturnPath: null,
        anyOnlineServerId: "srv-2",
      }),
    ).toEqual({
      kind: "fallback-route",
      route: "/h/srv-2/open-project",
    });
  });

  it("gives keyboard settings-return the same online-host fallback as the UI back button", () => {
    expect(
      resolveSettingsBackDestination({
        entryReturnPath: null,
        anyOnlineServerId: "srv-keyboard",
      }),
    ).toEqual({
      kind: "fallback-route",
      route: "/h/srv-keyboard/open-project",
    });
  });

  it("falls back to the app root without an entry route or online host", () => {
    expect(
      resolveSettingsBackDestination({
        entryReturnPath: null,
        anyOnlineServerId: null,
      }),
    ).toEqual({
      kind: "fallback-route",
      route: "/",
    });
  });
});

describe("resolveCompactSettingsDetailBackDestination", () => {
  it("returns to the settings root when the current settings session has an entry context", () => {
    expect(
      resolveCompactSettingsDetailBackDestination({
        hasEntryContext: true,
        canGoBack: true,
      }),
    ).toEqual({
      kind: "settings-root",
    });
  });

  it("uses router back for direct compact detail routes with navigation history", () => {
    expect(
      resolveCompactSettingsDetailBackDestination({
        hasEntryContext: false,
        canGoBack: true,
      }),
    ).toEqual({
      kind: "router-back",
    });
  });

  it("falls back to the settings root when router history is empty", () => {
    expect(
      resolveCompactSettingsDetailBackDestination({
        hasEntryContext: false,
        canGoBack: false,
      }),
    ).toEqual({
      kind: "settings-root",
    });
  });
});
