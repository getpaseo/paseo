import { describe, expect, it } from "vitest";
import {
  createDefaultDirectConnectionDraft,
  directConnectionDraftFromHint,
  directConnectionDraftFromPageLocation,
  normalizeDirectConnectionDraft,
  resolveInitialDirectConnectionDraft,
} from "./add-host-direct-draft";

describe("resolveInitialDirectConnectionDraft", () => {
  it("defaults to localhost:6767 when no same-origin hint is present", () => {
    expect(resolveInitialDirectConnectionDraft(null)).toEqual(createDefaultDirectConnectionDraft());
  });

  it("prefers the browser page location when a same-origin hint is present", () => {
    expect(
      resolveInitialDirectConnectionDraft(
        {
          listen: "5.78.184.144.nip.io",
          useTls: true,
        },
        {
          hostname: "5.78.184.144.nip.io",
          port: "",
          protocol: "https:",
        },
      ),
    ).toEqual({
      host: "5.78.184.144.nip.io",
      port: "443",
      useTls: true,
      password: "",
    });
  });

  it("does not use the page location when there is no daemon hint", () => {
    expect(
      resolveInitialDirectConnectionDraft(null, {
        hostname: "metro-host",
        port: "8081",
        protocol: "http:",
      }),
    ).toEqual(createDefaultDirectConnectionDraft());
  });
});

describe("directConnectionDraftFromHint", () => {
  it("uses scheme default ports when the Host header omits them", () => {
    expect(
      directConnectionDraftFromHint({
        listen: "5.78.184.144.nip.io",
        useTls: true,
      }),
    ).toEqual({
      host: "5.78.184.144.nip.io",
      port: "443",
      useTls: true,
      password: "",
    });
  });
});

describe("directConnectionDraftFromPageLocation", () => {
  it("maps https nip.io with an empty port to 443", () => {
    expect(
      directConnectionDraftFromPageLocation({
        hostname: "5.78.184.144.nip.io",
        port: "",
        protocol: "https:",
      }),
    ).toEqual({
      host: "5.78.184.144.nip.io",
      port: "443",
      useTls: true,
      password: "",
    });
  });
});

describe("normalizeDirectConnectionDraft", () => {
  it("falls back to the same-origin draft when host is empty", () => {
    expect(
      normalizeDirectConnectionDraft(
        {
          host: "  ",
          port: "",
          useTls: false,
          password: "secret",
        },
        {
          host: "5.78.184.144.nip.io",
          port: "443",
          useTls: true,
          password: "",
        },
      ),
    ).toEqual({
      host: "5.78.184.144.nip.io",
      port: "443",
      useTls: false,
      password: "secret",
    });
  });
});
