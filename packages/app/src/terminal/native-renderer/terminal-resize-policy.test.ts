import { describe, expect, test } from "vitest";

import { createTerminalResizePolicy, updateTerminalResizePolicy } from "./terminal-resize-policy";

describe("terminal resize policy", () => {
  test("passive first layout records measured size without claiming terminal size", () => {
    const initial = createTerminalResizePolicy({ rows: 24, cols: 80 });

    const result = updateTerminalResizePolicy(initial, {
      source: "measure",
      size: { rows: 41, cols: 48 },
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 41, cols: 48 },
        claimedSize: null,
        lastClaimToken: null,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 41, cols: 48 },
      resizeClaim: null,
      measuredSizeChanged: true,
    });
  });

  test("focus or explicit ownership claims the measured size", () => {
    const measured = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 24, cols: 80 }),
      {
        source: "measure",
        size: { rows: 41, cols: 48 },
      },
    );

    const result = updateTerminalResizePolicy(measured.state, {
      source: "claim",
      size: { rows: 41, cols: 48 },
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 41, cols: 48 },
        claimedSize: { rows: 41, cols: 48 },
        lastClaimToken: null,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 41, cols: 48 },
      resizeClaim: { rows: 41, cols: 48, force: false },
      measuredSizeChanged: false,
    });
  });

  test("focus or explicit ownership before measurement claims the next measured size", () => {
    const pendingClaim = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 24, cols: 80 }),
      {
        source: "claim",
        size: null,
      },
    );

    const result = updateTerminalResizePolicy(pendingClaim.state, {
      source: "measure",
      size: { rows: 41, cols: 48 },
    });

    expect(pendingClaim).toEqual({
      state: {
        measuredSize: { rows: 24, cols: 80 },
        claimedSize: null,
        lastClaimToken: null,
        pendingClaim: true,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 24, cols: 80 },
      resizeClaim: null,
      measuredSizeChanged: false,
    });
    expect(result).toEqual({
      state: {
        measuredSize: { rows: 41, cols: 48 },
        claimedSize: { rows: 41, cols: 48 },
        lastClaimToken: null,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 41, cols: 48 },
      resizeClaim: { rows: 41, cols: 48, force: false },
      measuredSizeChanged: true,
    });
  });

  test("duplicate claimed sizes are deduped", () => {
    const firstClaim = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 24, cols: 80 }),
      {
        source: "claim",
        size: { rows: 41, cols: 48 },
        claimToken: 1,
      },
    );

    const result = updateTerminalResizePolicy(firstClaim.state, {
      source: "claim",
      size: { rows: 41, cols: 48 },
      claimToken: 1,
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 41, cols: 48 },
        claimedSize: { rows: 41, cols: 48 },
        lastClaimToken: 1,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 41, cols: 48 },
      resizeClaim: null,
      measuredSizeChanged: false,
    });
  });

  test("explicit interaction can reclaim the same measured size", () => {
    const firstClaim = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 24, cols: 80 }),
      {
        source: "claim",
        size: { rows: 21, cols: 55 },
        claimToken: 1,
      },
    );

    const result = updateTerminalResizePolicy(firstClaim.state, {
      source: "claim",
      size: { rows: 21, cols: 55 },
      claimToken: 2,
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 21, cols: 55 },
        claimedSize: { rows: 21, cols: 55 },
        lastClaimToken: 2,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 21, cols: 55 },
      resizeClaim: { rows: 21, cols: 55, force: true },
      measuredSizeChanged: false,
    });
  });

  test("explicit interaction can reclaim after policy reset loses the previous claimed size", () => {
    const resetPolicy = createTerminalResizePolicy({ rows: 21, cols: 55 });

    const result = updateTerminalResizePolicy(resetPolicy, {
      source: "claim",
      size: { rows: 21, cols: 55 },
      claimToken: 2,
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 21, cols: 55 },
        claimedSize: { rows: 21, cols: 55 },
        lastClaimToken: 2,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 21, cols: 55 },
      resizeClaim: { rows: 21, cols: 55, force: true },
      measuredSizeChanged: false,
    });
  });

  test("explicit interaction before measurement forces the next measured reclaim after policy reset", () => {
    const pendingClaim = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 21, cols: 55 }),
      {
        source: "claim",
        size: null,
        claimToken: 2,
      },
    );

    const result = updateTerminalResizePolicy(pendingClaim.state, {
      source: "measure",
      size: { rows: 21, cols: 55 },
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 21, cols: 55 },
        claimedSize: { rows: 21, cols: 55 },
        lastClaimToken: 2,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 21, cols: 55 },
      resizeClaim: { rows: 21, cols: 55, force: true },
      measuredSizeChanged: false,
    });
  });

  test("passive measurement of the same size still dedupes after a claim", () => {
    const firstClaim = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 24, cols: 80 }),
      {
        source: "claim",
        size: { rows: 21, cols: 55 },
        claimToken: 1,
      },
    );

    const result = updateTerminalResizePolicy(firstClaim.state, {
      source: "measure",
      size: { rows: 21, cols: 55 },
    });

    expect(result).toEqual({
      state: {
        measuredSize: { rows: 21, cols: 55 },
        claimedSize: { rows: 21, cols: 55 },
        lastClaimToken: 1,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 21, cols: 55 },
      resizeClaim: null,
      measuredSizeChanged: false,
    });
  });

  test("passive layout changes never reuse an earlier explicit claim", () => {
    const firstClaim = updateTerminalResizePolicy(
      createTerminalResizePolicy({ rows: 24, cols: 80 }),
      {
        source: "claim",
        size: { rows: 41, cols: 48 },
      },
    );
    const duplicateLayout = updateTerminalResizePolicy(firstClaim.state, {
      source: "measure",
      size: { rows: 41, cols: 48 },
    });

    const changedLayout = updateTerminalResizePolicy(duplicateLayout.state, {
      source: "measure",
      size: { rows: 43, cols: 50 },
    });

    expect(duplicateLayout.resizeClaim).toEqual(null);
    expect(changedLayout.resizeClaim).toEqual(null);
    expect(changedLayout.measuredSize).toEqual({ rows: 43, cols: 50 });
  });

  test("keyboard measurement stays passive until the interaction explicitly reclaims", () => {
    const focused = updateTerminalResizePolicy(createTerminalResizePolicy({ rows: 24, cols: 80 }), {
      source: "claim",
      size: { rows: 41, cols: 53 },
    });

    const keyboardOpen = updateTerminalResizePolicy(focused.state, {
      source: "measure",
      size: { rows: 26, cols: 53 },
    });

    expect(keyboardOpen).toEqual({
      state: {
        measuredSize: { rows: 26, cols: 53 },
        claimedSize: { rows: 41, cols: 53 },
        lastClaimToken: null,
        pendingClaim: false,
        pendingForceClaim: false,
      },
      measuredSize: { rows: 26, cols: 53 },
      resizeClaim: null,
      measuredSizeChanged: true,
    });

    const settledKeyboardClaim = updateTerminalResizePolicy(keyboardOpen.state, {
      source: "claim",
      size: { rows: 26, cols: 53 },
      claimToken: 1,
    });

    expect(settledKeyboardClaim.resizeClaim).toEqual({ rows: 26, cols: 53, force: true });
  });
});
