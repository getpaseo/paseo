import { expect, it } from "vitest";
import { parseFloatingWidget } from "./validation";

const contribution = { id: "pet", title: "Pet", Component: () => null };
it("keeps toolbar as the default and accepts content-only chrome", () => {
  expect(parseFloatingWidget(contribution).chrome).toBe("toolbar");
  expect(parseFloatingWidget({ ...contribution, chrome: "none" }).chrome).toBe("none");
});

it("rejects unknown chrome instead of silently rendering a different interaction model", () => {
  expect(() =>
    parseFloatingWidget({ ...contribution, ...JSON.parse('{"chrome":"window"}') }),
  ).toThrow("invalid chrome");
});
