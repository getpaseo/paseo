import { describe, expect, it } from "vitest";
import { ManagedHostRegistrySchema } from "./managed-hosts";

describe("ManagedHostRegistrySchema", () => {
  it("normalizes a direct host registry", () => {
    expect(
      ManagedHostRegistrySchema.parse({
        version: 1,
        hosts: [
          {
            label: " Ryzen ",
            endpoint: " ryzen-shine:6767 ",
            password: "secret",
          },
        ],
      }),
    ).toEqual({
      version: 1,
      hosts: [
        {
          label: "Ryzen",
          endpoint: "ryzen-shine:6767",
          useTls: false,
          password: "secret",
        },
      ],
    });
  });

  it("rejects unsupported registry versions", () => {
    expect(() => ManagedHostRegistrySchema.parse({ version: 2, hosts: [] })).toThrow();
  });
});
