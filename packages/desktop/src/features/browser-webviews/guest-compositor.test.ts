import { describe, expect, it } from "vitest";
import {
  RUNAWAY_GUEST_CHECKS_TO_RELOAD,
  RUNAWAY_GUEST_MAX_RELOADS,
  RUNAWAY_GUEST_RELOAD_COOLDOWN_MS,
  RUNAWAY_GUEST_WORKING_SET_KiB,
  backgroundThrottlingAllowed,
  createGuestCompositor,
  guestCompositorBudget,
  guestLifecycleState,
  runawayGuestAction,
  type GuestCompositorTarget,
} from "./guest-compositor.js";

class FakeGuest implements GuestCompositorTarget {
  public readonly backgroundThrottlingCalls: boolean[] = [];
  public reloadCount = 0;
  public crashCount = 0;
  public destroyed = false;

  public constructor(
    public readonly id: number,
    public osProcessId: number,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed);
  }

  public reload(): void {
    this.reloadCount += 1;
  }

  public forcefullyCrashRenderer(): void {
    this.crashCount += 1;
  }

  public getOSProcessId(): number {
    return this.osProcessId;
  }
}

describe("guest compositor budget", () => {
  it("parks a guest that is not presented and has no live hold", () => {
    expect(
      guestCompositorBudget({
        isPresentedInHostWindow: false,
        isActiveInHostWindow: false,
        liveHoldCount: 0,
      }),
    ).toBe("parked");
  });

  it("keeps a presented guest live", () => {
    expect(
      guestCompositorBudget({
        isPresentedInHostWindow: true,
        isActiveInHostWindow: false,
        liveHoldCount: 0,
      }),
    ).toBe("live");
  });

  it("keeps the workspace-active guest live even when it is not presented", () => {
    expect(
      guestCompositorBudget({
        isPresentedInHostWindow: false,
        isActiveInHostWindow: true,
        liveHoldCount: 0,
      }),
    ).toBe("live");
  });

  it("keeps a parked guest live while a capture or automation hold is open", () => {
    expect(
      guestCompositorBudget({
        isPresentedInHostWindow: false,
        isActiveInHostWindow: false,
        liveHoldCount: 1,
      }),
    ).toBe("live");
  });

  it("allows Chromium background throttling only while parked", () => {
    expect(backgroundThrottlingAllowed("parked")).toBe(true);
    expect(backgroundThrottlingAllowed("live")).toBe(false);
  });

  it("freezes parked guests and leaves live guests active", () => {
    expect(guestLifecycleState("parked")).toBe("frozen");
    expect(guestLifecycleState("live")).toBe("active");
  });
});

describe("runaway guest action", () => {
  const overBudget = {
    workingSetKiB: RUNAWAY_GUEST_WORKING_SET_KiB + 1,
    consecutiveOverBudgetChecks: RUNAWAY_GUEST_CHECKS_TO_RELOAD,
    msSinceLastReload: RUNAWAY_GUEST_RELOAD_COOLDOWN_MS,
    reloadsThisGeneration: 0,
  };

  it("does nothing while the renderer is under the working-set budget", () => {
    expect(
      runawayGuestAction({
        ...overBudget,
        workingSetKiB: RUNAWAY_GUEST_WORKING_SET_KiB,
      }),
    ).toBe("none");
  });

  it("waits for consecutive over-budget checks before reloading", () => {
    expect(
      runawayGuestAction({
        ...overBudget,
        consecutiveOverBudgetChecks: RUNAWAY_GUEST_CHECKS_TO_RELOAD - 1,
      }),
    ).toBe("none");
  });

  it("reloads once the renderer stays over budget", () => {
    expect(runawayGuestAction(overBudget)).toBe("reload");
  });

  it("respects the reload cooldown", () => {
    expect(
      runawayGuestAction({
        ...overBudget,
        msSinceLastReload: RUNAWAY_GUEST_RELOAD_COOLDOWN_MS - 1,
        reloadsThisGeneration: 1,
      }),
    ).toBe("none");
  });

  it("crashes the renderer after the reload cap", () => {
    expect(
      runawayGuestAction({
        ...overBudget,
        reloadsThisGeneration: RUNAWAY_GUEST_MAX_RELOADS,
      }),
    ).toBe("crash");
  });
});

describe("createGuestCompositor", () => {
  it("throttles and freezes parked guests, and unthrottles presented ones", async () => {
    const lifecycle: Array<{ id: number; state: "active" | "frozen" }> = [];
    const compositor = createGuestCompositor({
      setLifecycleState: async (contents, state) => {
        lifecycle.push({ id: contents.id, state });
      },
    });
    const parked = new FakeGuest(1, 11);
    const presented = new FakeGuest(2, 22);
    const guests = new Map<number, FakeGuest>([
      [parked.id, parked],
      [presented.id, presented],
    ]);

    compositor.setPresented({
      hostWebContentsId: 100,
      browserId: "browser-presented",
      presented: true,
    });
    await compositor.applyBudgets({
      guests: [
        {
          webContentsId: parked.id,
          browserId: "browser-parked",
          hostWebContentsId: 100,
        },
        {
          webContentsId: presented.id,
          browserId: "browser-presented",
          hostWebContentsId: 100,
        },
      ],
      getContents: (id) => guests.get(id) ?? null,
    });

    expect(parked.backgroundThrottlingCalls).toEqual([true]);
    expect(presented.backgroundThrottlingCalls).toEqual([false]);
    expect(lifecycle).toEqual([
      { id: parked.id, state: "frozen" },
      { id: presented.id, state: "active" },
    ]);
  });

  it("unthrottles the workspace-active guest even when it is not presented", async () => {
    const compositor = createGuestCompositor({
      setLifecycleState: async () => {},
    });
    const guest = new FakeGuest(8, 88);
    compositor.setActive({
      hostWebContentsId: 100,
      browserId: "browser-active",
    });
    await compositor.applyBudgets({
      guests: [
        {
          webContentsId: guest.id,
          browserId: "browser-active",
          hostWebContentsId: 100,
        },
      ],
      getContents: () => guest,
    });

    expect(guest.backgroundThrottlingCalls).toEqual([false]);
  });

  it("does not re-apply an unchanged budget", async () => {
    const compositor = createGuestCompositor({
      setLifecycleState: async () => {},
    });
    const guest = new FakeGuest(3, 33);
    compositor.setPresented({
      hostWebContentsId: 100,
      browserId: "browser-a",
      presented: true,
    });
    const input = {
      guests: [
        {
          webContentsId: guest.id,
          browserId: "browser-a",
          hostWebContentsId: 100,
        },
      ],
      getContents: () => guest,
    };

    await compositor.applyBudgets(input);
    await compositor.applyBudgets(input);

    expect(guest.backgroundThrottlingCalls).toEqual([false]);
  });

  it("unthrottles a parked guest for the duration of a live hold", async () => {
    const lifecycle: Array<"active" | "frozen"> = [];
    const compositor = createGuestCompositor({
      setLifecycleState: async (_contents, state) => {
        lifecycle.push(state);
      },
    });
    const guest = new FakeGuest(4, 44);
    const apply = () =>
      compositor.applyBudgets({
        guests: [
          {
            webContentsId: guest.id,
            browserId: "browser-held",
            hostWebContentsId: 100,
          },
        ],
        getContents: () => guest,
      });

    await apply();
    expect(guest.backgroundThrottlingCalls).toEqual([true]);
    expect(lifecycle).toEqual(["frozen"]);

    await compositor.withLiveHold(guest.id, async () => {
      await apply();
      expect(guest.backgroundThrottlingCalls).toEqual([true, false]);
      expect(lifecycle).toEqual(["frozen", "active"]);
    });
    await apply();

    expect(guest.backgroundThrottlingCalls).toEqual([true, false, true]);
    expect(lifecycle).toEqual(["frozen", "active", "frozen"]);
  });

  it("keeps a guest live until the last overlapping hold ends", async () => {
    const compositor = createGuestCompositor({
      setLifecycleState: async () => {},
    });
    const guest = new FakeGuest(5, 55);
    const apply = () =>
      compositor.applyBudgets({
        guests: [
          {
            webContentsId: guest.id,
            browserId: "browser-overlap",
            hostWebContentsId: 100,
          },
        ],
        getContents: () => guest,
      });

    const innerHold = async () => {
      await apply();
      expect(guest.backgroundThrottlingCalls).toEqual([false]);
    };
    const outerHold = async () => {
      await compositor.withLiveHold(guest.id, innerHold);
      await apply();
      expect(guest.backgroundThrottlingCalls).toEqual([false]);
    };
    await compositor.withLiveHold(guest.id, outerHold);
    await apply();

    expect(guest.backgroundThrottlingCalls).toEqual([false, true]);
  });

  it("reloads a renderer that stays over the working-set budget, then crashes it", () => {
    const compositor = createGuestCompositor({
      now: (() => {
        let current = 1_000_000;
        return () => {
          current += RUNAWAY_GUEST_RELOAD_COOLDOWN_MS;
          return current;
        };
      })(),
    });
    const guest = new FakeGuest(6, 66);
    const input = {
      guests: [
        {
          webContentsId: guest.id,
          browserId: "browser-runaway",
          hostWebContentsId: 100,
        },
      ],
      getContents: () => guest,
      metrics: [
        {
          pid: guest.osProcessId,
          type: "Tab",
          memory: { workingSetSize: RUNAWAY_GUEST_WORKING_SET_KiB + 8_192 },
        },
      ],
    };

    for (let index = 0; index < RUNAWAY_GUEST_CHECKS_TO_RELOAD; index += 1) {
      compositor.handleRunawayGuests(input);
    }
    expect(guest.reloadCount).toBe(1);
    expect(guest.crashCount).toBe(0);

    for (let index = 0; index < RUNAWAY_GUEST_MAX_RELOADS - 1; index += 1) {
      for (let check = 0; check < RUNAWAY_GUEST_CHECKS_TO_RELOAD; check += 1) {
        compositor.handleRunawayGuests(input);
      }
    }
    expect(guest.reloadCount).toBe(RUNAWAY_GUEST_MAX_RELOADS);

    for (let check = 0; check < RUNAWAY_GUEST_CHECKS_TO_RELOAD; check += 1) {
      compositor.handleRunawayGuests(input);
    }
    expect(guest.crashCount).toBe(1);
  });

  it("does not reload a renderer that is under budget", () => {
    const compositor = createGuestCompositor();
    const guest = new FakeGuest(7, 77);
    compositor.handleRunawayGuests({
      guests: [
        {
          webContentsId: guest.id,
          browserId: "browser-healthy",
          hostWebContentsId: 100,
        },
      ],
      getContents: () => guest,
      metrics: [
        {
          pid: guest.osProcessId,
          type: "Tab",
          memory: { workingSetSize: 200_000 },
        },
      ],
    });
    compositor.handleRunawayGuests({
      guests: [
        {
          webContentsId: guest.id,
          browserId: "browser-healthy",
          hostWebContentsId: 100,
        },
      ],
      getContents: () => guest,
      metrics: [
        {
          pid: guest.osProcessId,
          type: "Tab",
          memory: { workingSetSize: 200_000 },
        },
      ],
    });

    expect(guest.reloadCount).toBe(0);
    expect(guest.crashCount).toBe(0);
  });
});
