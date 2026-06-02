import { describe, expect, it } from "vitest";
import {
  DaemonConnectionRegistrationError,
  DaemonManagementOperationError,
  getDaemonManagementErrorPresentation,
} from "./daemon-management-error";

describe("getDaemonManagementErrorPresentation", () => {
  it("refreshes status when the daemon started but localhost registration failed", () => {
    const presentation = getDaemonManagementErrorPresentation(
      new DaemonConnectionRegistrationError("Desktop daemon did not return a listen address."),
      false,
    );

    expect(presentation).toEqual({
      message:
        "Built-in daemon started, but Paseo could not save the localhost connection. Toggle daemon management off and on again, or add localhost manually.",
      refreshStatus: true,
    });
  });

  it("does not refresh status for daemon stop failures", () => {
    const presentation = getDaemonManagementErrorPresentation(new Error("stop failed"), true);

    expect(presentation).toEqual({
      message: "Built-in daemon management was paused, but Paseo could not stop the daemon.",
      refreshStatus: false,
    });
  });

  it("uses the pre-mutation daemon management state for operation failures", () => {
    const presentation = getDaemonManagementErrorPresentation(
      new DaemonManagementOperationError(new Error("stop failed"), true),
      false,
    );

    expect(presentation).toEqual({
      message: "Built-in daemon management was paused, but Paseo could not stop the daemon.",
      refreshStatus: false,
    });
  });

  it("does not refresh status for generic update failures", () => {
    const presentation = getDaemonManagementErrorPresentation(new Error("settings failed"), false);

    expect(presentation).toEqual({
      message: "Unable to update built-in daemon management.",
      refreshStatus: false,
    });
  });
});
