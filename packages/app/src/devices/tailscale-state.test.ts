import { describe, expect, it } from "vitest";
import type { TailscaleStatus } from "@getpaseo/protocol/messages";
import { resolveTailscaleControlState, type TailscaleControlStateInput } from "./tailscale-state";

const baseInput: TailscaleControlStateInput = {
  status: undefined,
  statusUpdatedAt: 0,
  statusError: false,
  changePending: false,
  changeError: false,
  refreshPending: false,
  refreshError: false,
  refreshSubmittedAt: 0,
};

const unavailable: TailscaleStatus = { ip: null, address: null, state: "unavailable" };
const waiting: TailscaleStatus = { ip: null, address: "100.101.102.103:6767", state: "waiting" };
const off: TailscaleStatus = { ip: "100.101.102.103", address: null, state: "off" };
const on: TailscaleStatus = { ip: "100.101.102.103", address: "100.101.102.103:6767", state: "on" };

describe("resolveTailscaleControlState", () => {
  it("reserves the switch space without Refresh during initial load", () => {
    expect(resolveTailscaleControlState(baseInput)).toEqual({
      value: null,
      showSwitch: true,
      switchDisabled: true,
      showRefresh: false,
      refreshing: false,
      refreshDisabled: false,
      showInstallLink: false,
      address: null,
      errorKey: null,
    });
  });

  it("shows Refresh, install link, and a disabled switch when Tailscale is unavailable", () => {
    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: unavailable,
        statusUpdatedAt: 1000,
      }),
    ).toEqual({
      value: false,
      showSwitch: true,
      switchDisabled: true,
      showRefresh: true,
      refreshing: false,
      refreshDisabled: false,
      showInstallLink: true,
      address: null,
      errorKey: null,
    });
  });

  it("shows Refresh alongside the enabled switch when Tailscale is waiting", () => {
    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: waiting,
        statusUpdatedAt: 1000,
      }),
    ).toEqual({
      value: true,
      showSwitch: true,
      switchDisabled: false,
      showRefresh: true,
      refreshing: false,
      refreshDisabled: false,
      showInstallLink: false,
      address: null,
      errorKey: null,
    });
  });

  it("hides Refresh once Tailscale becomes available or active", () => {
    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: off,
        statusUpdatedAt: 2000,
      }),
    ).toMatchObject({
      value: false,
      showSwitch: true,
      switchDisabled: false,
      showRefresh: false,
      showInstallLink: false,
      address: null,
    });

    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: on,
        statusUpdatedAt: 3000,
      }),
    ).toMatchObject({
      value: true,
      showSwitch: true,
      switchDisabled: false,
      showRefresh: false,
      showInstallLink: false,
      address: "100.101.102.103:6767",
    });
  });

  it("shows Refresh without an empty switch spacer when initial status check fails, and keeps it visible while retrying", () => {
    expect(
      resolveTailscaleControlState({
        ...baseInput,
        statusError: true,
      }),
    ).toEqual({
      value: null,
      showSwitch: false,
      switchDisabled: true,
      showRefresh: true,
      refreshing: false,
      refreshDisabled: false,
      showInstallLink: false,
      address: null,
      errorKey: "devices.tailscale.statusError",
    });

    expect(
      resolveTailscaleControlState({
        ...baseInput,
        statusError: true,
        refreshPending: true,
        refreshSubmittedAt: 1500,
      }),
    ).toEqual({
      value: null,
      showSwitch: false,
      switchDisabled: true,
      showRefresh: true,
      refreshing: true,
      refreshDisabled: true,
      showInstallLink: false,
      address: null,
      errorKey: null,
    });
  });

  it("surfaces a failed manual refresh even when a prior status is loaded, and clears it once a newer status arrives", () => {
    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: unavailable,
        statusUpdatedAt: 1000,
        refreshError: true,
        refreshSubmittedAt: 2000,
      }),
    ).toMatchObject({
      showRefresh: true,
      errorKey: "devices.tailscale.statusError",
    });

    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: unavailable,
        statusUpdatedAt: 3000,
        refreshError: true,
        refreshSubmittedAt: 2000,
      }),
    ).toMatchObject({
      showRefresh: true,
      errorKey: null,
    });
  });

  it("prevents concurrent refresh and toggle actions", () => {
    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: waiting,
        statusUpdatedAt: 1000,
        refreshPending: true,
      }),
    ).toMatchObject({
      switchDisabled: true,
      refreshing: true,
      refreshDisabled: true,
    });

    expect(
      resolveTailscaleControlState({
        ...baseInput,
        status: waiting,
        statusUpdatedAt: 1000,
        changePending: true,
        changePendingEnabled: false,
      }),
    ).toMatchObject({
      value: false,
      switchDisabled: true,
      refreshing: false,
      refreshDisabled: true,
    });
  });
});
