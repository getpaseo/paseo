import { describe, expect, it } from "vitest";
import type { AgentOptionControl } from "@getpaseo/protocol/agent-types";
import { isControlActive } from "./option-controls";
import {
  draftControlsRequest,
  openDraftOptions,
  ownDraftOptions,
  viewDraftOptions,
} from "./draft-options-model";

const SPEED: AgentOptionControl = {
  type: "select",
  key: "service_tier",
  label: "Speed",
  defaultValue: "default",
  choices: [
    { value: "default", label: "Standard" },
    { value: "priority", label: "Fast" },
  ],
};
const WEB_SEARCH: AgentOptionControl = { type: "toggle", key: "web_search", label: "Web search" };

function answer(
  provider: string,
  requestKey: string,
  options: Record<string, unknown>,
  controls = [SPEED, WEB_SEARCH],
) {
  return { provider, requestKey, controls, options };
}

describe("draft options model", () => {
  it("draws a legacy Fast profile as the Fast tier the daemon resolved", () => {
    const model = openDraftOptions({ provider: "codex", seed: { service_tier: "fast" } });
    model.applyResolved(answer("codex", "k1", { service_tier: "priority" }));

    const view = viewDraftOptions(model.getState(), { provider: "codex", requestKey: "k1" });

    expect(view?.options).toEqual({ service_tier: "priority" });
    expect(view && isControlActive(SPEED, view.options)).toBe(true);
    // The daemon still gets the stored value to resolve, and so does create.
    expect(ownDraftOptions(model.getState())).toEqual({ service_tier: "fast" });
  });

  it("applying a profile from another provider keeps its options through the provider change", () => {
    const model = openDraftOptions({ provider: "claude" });
    model.applyResolved(answer("claude", "k1", {}));

    model.applyProfile({
      provider: "codex",
      options: { sandbox_mode: "read-only", service_tier: "fast" },
    });
    // The form follows the profile to its provider.
    model.observeProvider("codex");

    expect(ownDraftOptions(model.getState())).toEqual({
      sandbox_mode: "read-only",
      service_tier: "fast",
    });
    expect(model.getState().resolved).toBeNull();
  });

  it("choosing another provider by hand starts the options over", () => {
    const model = openDraftOptions({ provider: "codex", seed: { sandbox_mode: "read-only" } });
    model.setOption("web_search", true);

    model.observeProvider("claude");

    expect(ownDraftOptions(model.getState())).toBeUndefined();
    expect(model.getState().resolved).toBeNull();
  });

  it("never pairs a manually chosen provider with the previous provider's options", () => {
    const model = openDraftOptions({ provider: "claude" });
    model.applyResolved(answer("claude", "k1", { fast_mode: true }));
    model.setOption("fast_mode", true);
    const form = { provider: "claude", cwd: "/repo" };
    expect(draftControlsRequest(model.getState(), form)).toMatchObject({
      provider: "claude",
      providerOptions: { fast_mode: true },
    });

    // The form shows OpenCode on its next render; the model has not observed it yet.
    expect(draftControlsRequest(model.getState(), { ...form, provider: "opencode" })).toBeNull();

    model.observeProvider("opencode");
    const request = draftControlsRequest(model.getState(), { ...form, provider: "opencode" });
    expect(request).toEqual({ provider: "opencode", cwd: "/repo" });
  });

  it("keeps a draft's seed when the first provider is chosen", () => {
    const model = openDraftOptions({ provider: null, seed: { web_search: true } });

    model.observeProvider("claude");

    expect(ownDraftOptions(model.getState())).toEqual({ web_search: true });
  });

  it("sends a remembered value to the daemon, and draws only what comes back", () => {
    const model = openDraftOptions({ provider: "codex" });
    model.setRemembered({ service_tier: "fast", retired: true });
    // Nothing is known about the provider's controls yet.
    expect(ownDraftOptions(model.getState())).toBeUndefined();

    model.applyResolved(answer("codex", "k1", { service_tier: "default" }));
    expect(ownDraftOptions(model.getState())).toEqual({ service_tier: "fast" });
    // The answer to the first request does not show the remembered value as if it applied.
    expect(
      viewDraftOptions(model.getState(), { provider: "codex", requestKey: "k2" })?.options,
    ).toEqual({ service_tier: "default" });

    model.applyResolved(answer("codex", "k2", { service_tier: "priority" }));
    expect(
      viewDraftOptions(model.getState(), { provider: "codex", requestKey: "k2" })?.options,
    ).toEqual({ service_tier: "priority" });
  });

  it("does not let a remembered value override the seed", () => {
    const model = openDraftOptions({ provider: "codex", seed: { service_tier: "default" } });
    model.applyResolved(answer("codex", "k1", { service_tier: "default" }));
    model.setRemembered({ service_tier: "fast" });

    expect(ownDraftOptions(model.getState())).toEqual({ service_tier: "default" });
  });

  it("lays a toggle over the previous answer until the new one arrives", () => {
    const model = openDraftOptions({ provider: "claude" });
    model.applyResolved(answer("claude", "k1", { web_search: false }));

    model.setOption("web_search", true);

    expect(
      viewDraftOptions(model.getState(), { provider: "claude", requestKey: "k2" })?.options,
    ).toEqual({ web_search: true });
    model.applyResolved(answer("claude", "k2", { web_search: true }));
    expect(
      viewDraftOptions(model.getState(), { provider: "claude", requestKey: "k2" })?.options,
    ).toEqual({ web_search: true });
  });

  it("draws nothing for a provider the answer is not for", () => {
    const model = openDraftOptions({ provider: "claude" });
    model.applyResolved(answer("claude", "k1", {}));

    expect(viewDraftOptions(model.getState(), { provider: "codex", requestKey: "k1" })).toBe(
      undefined,
    );
  });
});
