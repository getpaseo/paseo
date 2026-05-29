import { describe, expect, it } from "vitest";
import {
  resolveUpdateCalloutDescriptor,
  type ResolveUpdateCalloutInput,
} from "./resolve-update-callout";

function input(overrides: Partial<ResolveUpdateCalloutInput> = {}): ResolveUpdateCalloutInput {
  return {
    isDesktopApp: true,
    status: "available",
    isInstalling: false,
    availableUpdate: { latestVersion: "1.2.3" },
    errorMessage: null,
    ...overrides,
  };
}

describe("resolveUpdateCalloutDescriptor", () => {
  it("returns null when not running as a desktop app", () => {
    expect(resolveUpdateCalloutDescriptor(input({ isDesktopApp: false }))).toBeNull();
  });

  it("returns null for idle / checking / up-to-date / pending statuses", () => {
    for (const status of ["idle", "checking", "up-to-date", "pending"] as const) {
      expect(resolveUpdateCalloutDescriptor(input({ status }))).toBeNull();
    }
  });

  it("builds an update-available descriptor with changelog + install actions", () => {
    const descriptor = resolveUpdateCalloutDescriptor(input());

    expect(descriptor).not.toBeNull();
    expect(descriptor?.id).toBe("desktop-update");
    expect(descriptor?.priority).toBe(200);
    expect(descriptor?.testID).toBe("update-callout");
    expect(descriptor?.title).toBe("Update available");
    expect(descriptor?.variant).toBe("default");
    expect(descriptor?.showGiftIcon).toBe(true);
    expect(descriptor?.body).toEqual({ kind: "available", versionLabel: "v1.2.3" });
    expect(descriptor?.actions).toEqual([
      { role: "changelog", label: "What's new" },
      { role: "install", label: "Install & restart", variant: "primary", disabled: false },
    ]);
    expect(descriptor?.dismissalKey).toBe("desktop-update:available:1.2.3");
  });

  it("normalizes a leading v in the latest version", () => {
    const descriptor = resolveUpdateCalloutDescriptor(
      input({ availableUpdate: { latestVersion: "v2.0.0" } }),
    );
    expect(descriptor?.body).toEqual({ kind: "available", versionLabel: "v2.0.0" });
  });

  it("omits the version label when no latest version is known", () => {
    const descriptor = resolveUpdateCalloutDescriptor(
      input({ availableUpdate: { latestVersion: null } }),
    );
    expect(descriptor?.body).toEqual({ kind: "available", versionLabel: null });
    expect(descriptor?.dismissalKey).toBe("desktop-update:available:unknown");
  });

  it("disables the install action and labels it Installing... while installing", () => {
    const descriptor = resolveUpdateCalloutDescriptor(
      input({ status: "installing", isInstalling: true }),
    );

    expect(descriptor?.title).toBe("Installing update");
    expect(descriptor?.body).toEqual({ kind: "installing" });
    expect(descriptor?.showGiftIcon).toBe(false);
    expect(descriptor?.variant).toBe("default");
    expect(descriptor?.actions).toEqual([
      { role: "changelog", label: "What's new" },
      { role: "install", label: "Installing...", variant: "primary", disabled: true },
    ]);
    expect(descriptor?.dismissalKey).toBe("desktop-update:installing:1.2.3");
  });

  it("shows a retry action and surfaces the error message on error", () => {
    const descriptor = resolveUpdateCalloutDescriptor(
      input({ status: "error", errorMessage: "Download failed", availableUpdate: null }),
    );

    expect(descriptor?.title).toBe("Update failed");
    expect(descriptor?.body).toEqual({ kind: "error", message: "Download failed" });
    expect(descriptor?.variant).toBe("error");
    expect(descriptor?.showGiftIcon).toBe(false);
    expect(descriptor?.actions).toEqual([
      { role: "changelog", label: "What's new" },
      { role: "retry", label: "Retry", variant: "primary" },
    ]);
    expect(descriptor?.dismissalKey).toBe("desktop-update:error:unknown");
  });

  it("falls back to a generic error message when none is provided", () => {
    const descriptor = resolveUpdateCalloutDescriptor(
      input({ status: "error", errorMessage: null, availableUpdate: null }),
    );
    expect(descriptor?.body).toEqual({ kind: "error", message: "Something went wrong." });
  });

  it("encodes status and version into the dismissal key", () => {
    expect(
      resolveUpdateCalloutDescriptor(input({ availableUpdate: { latestVersion: "1.2.4" } }))
        ?.dismissalKey,
    ).toBe("desktop-update:available:1.2.4");
  });
});
