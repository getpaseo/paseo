import { memo, useMemo } from "react";
import Svg, { Rect } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { InboxKind } from "./inbox-model";

export type StatusGlyphName = "ask" | "approve" | "err" | "merge" | "done" | "plan" | "run";

// 8×8 pixel status marks from the Leitstand mockup; "K" is ink.
const GLYPHS: Record<StatusGlyphName, readonly string[]> = {
  ask: [
    "..KKKK..",
    ".KK..KK.",
    ".....KK.",
    "....KK..",
    "...KK...",
    "...KK...",
    "........",
    "...KK...",
  ],
  approve: [
    "..K.K...",
    "..K.K.K.",
    "K.K.K.K.",
    "K.KKKKK.",
    "KKKKKKK.",
    ".KKKKKK.",
    "..KKKK..",
    "..KKKK..",
  ],
  err: [
    "KK....KK",
    ".KK..KK.",
    "..KKKK..",
    "...KK...",
    "..KKKK..",
    ".KK..KK.",
    "KK....KK",
    "........",
  ],
  merge: [
    "KK....KK",
    "KK....KK",
    ".KK..KK.",
    "..KKKK..",
    "...KK...",
    "...KK...",
    "...KK...",
    "...KK...",
  ],
  done: [
    "........",
    "......KK",
    ".....KK.",
    "KK..KK..",
    ".KKKK...",
    "..KK....",
    "........",
    "........",
  ],
  plan: [
    "..KKKK..",
    ".K....K.",
    "K...K..K",
    "K...K..K",
    "K...KK.K",
    "K......K",
    ".K....K.",
    "..KKKK..",
  ],
  run: [
    "...KK...",
    "..KK....",
    "..KKKK..",
    "...KK...",
    "...KK...",
    "..KKKK..",
    "...KK...",
    "...KK...",
  ],
};

interface GlyphRun {
  x: number;
  y: number;
  width: number;
}

function toRuns(rows: readonly string[]): GlyphRun[] {
  const runs: GlyphRun[] = [];
  rows.forEach((row, y) => {
    for (const match of row.matchAll(/K+/g)) {
      runs.push({ x: match.index, y, width: match[0].length });
    }
  });
  return runs;
}

const PixelGlyph = memo(function PixelGlyph({
  name,
  size,
  color,
}: {
  name: StatusGlyphName;
  size: number;
  color: string;
}) {
  const runs = useMemo(() => toRuns(GLYPHS[name]), [name]);
  return (
    <Svg width={size} height={size} viewBox="0 0 8 8">
      {runs.map((run) => (
        <Rect
          key={`${run.x}-${run.y}`}
          x={run.x}
          y={run.y}
          width={run.width}
          height={1}
          fill={color}
        />
      ))}
    </Svg>
  );
});

const ThemedPixelGlyph = withUnistyles(PixelGlyph);

// Colour only where it means something: amber waits on you, red failed, violet merges.
const GLYPH_COLOR: Record<StatusGlyphName, (theme: Theme) => { color: string }> = {
  ask: (theme) => ({ color: theme.colors.statusWarning }),
  approve: (theme) => ({ color: theme.colors.statusWarning }),
  err: (theme) => ({ color: theme.colors.statusDanger }),
  merge: (theme) => ({ color: theme.colors.statusMerged }),
  done: (theme) => ({ color: theme.colors.foreground }),
  run: (theme) => ({ color: theme.colors.foreground }),
  plan: (theme) => ({ color: theme.colors.foregroundMuted }),
};

const GLYPH_GRID = 8;

/** A whole number of screen pixels per glyph pixel; 12 or 14 px blur an 8×8 mark into grey. */
export function snapGlyphSize(size: number): number {
  return Math.max(1, Math.round(size / GLYPH_GRID)) * GLYPH_GRID;
}

export function StatusGlyph({ name, size = 16 }: { name: StatusGlyphName; size?: number }) {
  return <ThemedPixelGlyph name={name} size={snapGlyphSize(size)} uniProps={GLYPH_COLOR[name]} />;
}

const BUCKET_GLYPH: Record<SidebarStateBucket, StatusGlyphName> = {
  needs_input: "ask",
  failed: "err",
  running: "run",
  attention: "done",
  done: "done",
};

export function glyphForBucket(bucket: SidebarStateBucket): StatusGlyphName {
  return BUCKET_GLYPH[bucket];
}

const KIND_GLYPH: Record<InboxKind, StatusGlyphName> = {
  permission: "approve",
  question: "ask",
  agent_error: "err",
  schedule_error: "err",
  checks_failed: "err",
  merge_ready: "merge",
  finished: "done",
};

export function glyphForInboxKind(kind: InboxKind): StatusGlyphName {
  return KIND_GLYPH[kind];
}
