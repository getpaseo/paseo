import { buildPandaRuns, type PandaRun } from "@/components/panda-sprite";
import {
  PANDA_STATUS_COLOR_KEYS,
  PANDA_STATUS_PALETTE,
  type PandaMood,
} from "@/components/panda-status-frames";
import type { Theme } from "@/styles/theme";

/** i18n key per mood; the accessibility label speaks the same state the sprite draws. */
export const PANDA_STATUS_LABEL_KEYS: Record<PandaMood, string> = {
  run: "panda.status.run",
  ask: "panda.status.ask",
  err: "panda.status.err",
  sleep: "panda.status.sleep",
};

/** run chews for one loop of 3 frames; the other moods hold a 2-frame loop. */
export const PANDA_STATUS_FRAME_MS = 600;

const statusWarningFillMapping = (theme: Theme) => ({ fill: theme.colors.statusWarning });
const statusDangerFillMapping = (theme: Theme) => ({ fill: theme.colors.statusDanger });

/** Maps a theme color key (from PANDA_STATUS_COLOR_KEYS) to its withUnistyles uniProps mapping. */
export const PANDA_STATUS_FILL_MAPPING: Record<string, (theme: Theme) => { fill: string }> = {
  statusWarning: statusWarningFillMapping,
  statusDanger: statusDangerFillMapping,
};

/**
 * Splits a frame into fixed-colour fur/contour runs and theme-coloured status runs. The two never
 * overlap, so rendering both sets covers every painted pixel exactly once.
 */
export function pandaStatusRuns(frame: readonly string[]): {
  furRuns: PandaRun[];
  statusRuns: PandaRun[];
} {
  return {
    furRuns: buildPandaRuns(frame, PANDA_STATUS_PALETTE),
    statusRuns: buildPandaRuns(frame, PANDA_STATUS_COLOR_KEYS),
  };
}
