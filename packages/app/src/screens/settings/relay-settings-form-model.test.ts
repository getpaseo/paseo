import { describe, expect, it, vi } from "vitest";
import { createRelaySettingsFormModel } from "./relay-settings-form-model";

const initialValues = {
  enabled: true,
  endpoint: "relay.paseo.sh:443",
  publicEndpoint: "relay.paseo.sh:443",
  useTls: true,
  publicUseTls: true,
};

describe("relay settings form model", () => {
  it("normalizes valid host:port values and builds a relay patch", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });

    model.setField("endpoint", " relay.internal.example:7443 ");
    model.setField("publicEndpoint", "[2001:db8::1]:443");
    model.setField("useTls", false);

    expect(model.getState()).toMatchObject({ isDirty: true, canSubmit: true });
    expect(model.buildPatch()).toEqual({
      relay: {
        endpoint: "relay.internal.example:7443",
        publicEndpoint: "[2001:db8::1]:443",
        useTls: false,
      },
    });
    expect(model.hasRestartRequiredChanges()).toBe(true);
  });

  it("rejects schemes, missing ports, and out-of-range ports", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });

    model.setField("endpoint", "wss://relay.example.com:443");
    model.setField("publicEndpoint", "relay.example.com:70000");

    expect(model.getState()).toMatchObject({
      canSubmit: false,
      errors: { endpoint: "hostPort", publicEndpoint: "hostPort" },
    });
    expect(model.buildPatch()).toBeNull();
  });

  it("rejects host values that would escape into URL credentials or paths", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });

    model.setField("endpoint", "relay user@example.com:443");
    model.setField("publicEndpoint", "relay.example.com/path:443");

    expect(model.getState()).toMatchObject({
      canSubmit: false,
      errors: { endpoint: "hostPort", publicEndpoint: "hostPort" },
    });
    expect(model.buildPatch()).toBeNull();
  });

  it("omits launch-controlled fields and exposes their environment variables", () => {
    const model = createRelaySettingsFormModel({
      initialValues,
      overrideControlledPaths: ["daemon.relay.endpoint", "daemon.relay.publicUseTls"],
    });

    model.setField("endpoint", "relay.ignored.example:443");
    model.setField("publicUseTls", false);
    model.setField("enabled", false);

    expect(model.getOverrideEnv("endpoint")).toBe("PASEO_RELAY_ENDPOINT");
    expect(model.getOverrideEnv("publicUseTls")).toBe("PASEO_RELAY_PUBLIC_USE_TLS");
    expect(model.buildPatch()).toEqual({ relay: { enabled: false } });
    expect(model.hasRestartRequiredChanges()).toBe(false);
  });

  it("notifies subscribers when a field changes", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);

    model.setField("enabled", false);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    model.setField("enabled", true);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("stops publishing and accepting edits after close", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });
    const listener = vi.fn();
    model.subscribe(listener);
    model.setField("endpoint", "relay.edited.example:443");

    model.close();
    model.setField("endpoint", "relay.after-close.example:443");

    expect(listener).toHaveBeenCalledOnce();
    expect(model.getState().values.endpoint).toBe("relay.edited.example:443");
  });

  it("locks saved values while restart is pending", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });
    model.setField("endpoint", "relay.new.example:443");

    model.startSaving();
    model.markRestartRequired();
    model.setField("endpoint", "relay.unsaved.example:443");

    expect(model.getState()).toMatchObject({
      phase: "restartRequired",
      values: { endpoint: "relay.new.example:443" },
    });
    expect(model.buildPatch()).toEqual({ relay: { endpoint: "relay.new.example:443" } });
  });

  it("returns to restartRequired with an actionable error when restart fails", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });
    model.setField("endpoint", "relay.new.example:443");
    model.startSaving();
    model.markRestartRequired();
    model.startMigrating();
    model.startRestarting();
    model.markRestartFailed("unable to reconnect");

    expect(model.getState()).toMatchObject({
      phase: "restartRequired",
      error: { kind: "restart", message: "unable to reconnect" },
    });
  });

  it("returns to restartRequired with a migration-specific error", () => {
    const model = createRelaySettingsFormModel({ initialValues, overrideControlledPaths: [] });
    model.setField("endpoint", "relay.new.example:443");
    model.startSaving();
    model.markRestartRequired();
    model.startMigrating();
    model.markMigrationFailed("unable to store connection");

    expect(model.getState()).toMatchObject({
      phase: "restartRequired",
      error: { kind: "migration", message: "unable to store connection" },
    });
  });
});
