import { describe, expect, test } from "vitest";

import {
  AgentRuntimeCapacityError,
  HostAgentRuntimeCapacityController,
} from "./agent-runtime-capacity.js";

describe("HostAgentRuntimeCapacityController", () => {
  test("atomically rejects a concurrent reservation at the host limit", () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const first = controller.reserve();

    expect(() => controller.reserve()).toThrow(
      expect.objectContaining<Partial<AgentRuntimeCapacityError>>({
        name: "AgentRuntimeCapacityError",
        live: 0,
        reserved: 1,
      }),
    );

    first.release();
    expect(() => controller.reserve()).not.toThrow();
  });

  test("keeps a started runtime charged until that exact runtime is released", () => {
    const controller = new HostAgentRuntimeCapacityController(1);
    const runtime = {};
    controller.reserve().track(runtime);

    expect(() => controller.reserve()).toThrow(
      expect.objectContaining<Partial<AgentRuntimeCapacityError>>({ live: 1, reserved: 0 }),
    );
    controller.release({});
    expect(() => controller.reserve()).toThrow(AgentRuntimeCapacityError);

    controller.release(runtime);
    expect(() => controller.reserve()).not.toThrow();
  });
});
