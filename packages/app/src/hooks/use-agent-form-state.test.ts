import { describe, expect, it } from "vitest";
import { __private__ } from "./use-agent-form-state";

describe("useAgentFormState", () => {
  describe("__private__.combineInitialValues", () => {
    it("returns undefined when no initial values and no initial server id", () => {
      expect(__private__.combineInitialValues(undefined, null)).toBeUndefined();
    });

    it("does not inject a null serverId override when initialValues are present but serverId is absent", () => {
      const combined = __private__.combineInitialValues({}, null);
      expect(combined).toEqual({});
      expect(Object.prototype.hasOwnProperty.call(combined, "serverId")).toBe(false);
    });

    it("injects serverId from options when provided", () => {
      expect(__private__.combineInitialValues({}, "daemon-1")).toEqual({
        serverId: "daemon-1",
      });
    });

    it("keeps other initial values without forcing serverId", () => {
      const combined = __private__.combineInitialValues({ workingDir: "/repo" }, null);
      expect(combined).toEqual({ workingDir: "/repo" });
      expect(Object.prototype.hasOwnProperty.call(combined, "serverId")).toBe(false);
    });

    it("respects an explicit serverId override (including null) over initialServerId", () => {
      expect(__private__.combineInitialValues({ serverId: null }, "daemon-1")).toEqual({
        serverId: null,
      });

      expect(__private__.combineInitialValues({ serverId: "daemon-2" }, "daemon-1")).toEqual({
        serverId: "daemon-2",
      });
    });
  });
});

