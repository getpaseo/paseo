import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import {
  STATUS_INDICATOR_DOT_SIZE,
  STATUS_INDICATOR_FILLED_DOT_SIZE,
} from "@/utils/status-indicator-geometry";
import { rotatorStyles, styles } from "./frame";
import {
  STATUS_RING_FRAME_SIZE,
  STATUS_RING_GAP,
  STATUS_RING_HALO_INSET,
  STATUS_RING_PERIOD_MS,
  STATUS_RING_SIZE,
  STATUS_RING_STROKE,
  getStatusRingOffset,
  getStatusRingRotation,
} from "./geometry";
import { getAndroidRunningIndicatorProps } from "./index.android";

describe("status ring geometry and Android indicator", () => {
  it("sizes the ring and knockout frame outward from the filled status dot", () => {
    expect(STATUS_RING_SIZE).toBe(
      STATUS_INDICATOR_FILLED_DOT_SIZE + (STATUS_RING_GAP + STATUS_RING_STROKE) * 2,
    );
    expect(STATUS_RING_FRAME_SIZE).toBe(STATUS_RING_SIZE + STATUS_RING_HALO_INSET * 2);
    expect(rotatorStyles.rotator).toEqual({
      position: "absolute",
      width: STATUS_RING_SIZE,
      height: STATUS_RING_SIZE,
    });
    expect(styles.frame.width).toBe(STATUS_RING_FRAME_SIZE);
    expect(styles.frame.height).toBe(STATUS_RING_FRAME_SIZE);
    expect(getStatusRingOffset(-2, STATUS_INDICATOR_DOT_SIZE)).toBe(-5);
  });

  it("computes wall-clock phase across the shared rotation period", () => {
    expect(getStatusRingRotation(0)).toBe(0);
    expect(getStatusRingRotation(STATUS_RING_PERIOD_MS / 4)).toBe(90);
    expect(getStatusRingRotation(STATUS_RING_PERIOD_MS / 2)).toBe(180);
    expect(getStatusRingRotation(STATUS_RING_PERIOD_MS)).toBe(0);
  });

  it("maps the Android running indicator color from the active theme", () => {
    expect(getAndroidRunningIndicatorProps(lightTheme)).toEqual({
      color: lightTheme.colors.statusDotRunning,
    });
    expect(getAndroidRunningIndicatorProps(darkTheme)).toEqual({
      color: darkTheme.colors.statusDotRunning,
    });
  });

  it("keeps the Android entry point free of Reanimated and the shared animation clock", () => {
    const source = ts.createSourceFile(
      "index.android.tsx",
      readFileSync(new URL("./index.android.tsx", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const imports: string[] = [];
    source.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
    });

    expect(imports).not.toContain("@/components/status-ring/clock");
    expect(imports).not.toContain("./clock");
    expect(imports).not.toContain("react-native-reanimated");
  });
});
