import { describe, expect, it } from "vitest";

const { configureClientCertificates } = require("./app.plugin");

describe("Android client certificate startup", () => {
  it("installs before the React Native runtime starts and is idempotent", () => {
    const result = configureClientCertificates("super.onCreate()\nloadReactNative(this)");
    expect(result).toBe(
      "super.onCreate()\n    sh.paseo.mtls.PaseoMtls.install(this)\nloadReactNative(this)",
    );
    expect(configureClientCertificates(result)).toBe(result);
  });

  it("rejects an unsupported application template", () => {
    expect(() => configureClientCertificates("changed template")).toThrow(
      "Could not install Android client certificates",
    );
  });
});
