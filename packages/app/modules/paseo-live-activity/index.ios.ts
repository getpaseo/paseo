import { requireOptionalNativeModule } from "expo";
import type { PaseoLiveActivityModule } from "./types";

export type {
  LiveActivityContentState,
  LiveActivityHeroState,
  PaseoLiveActivityModule,
} from "./types";

const unavailableModule: PaseoLiveActivityModule = {
  isSupported() {
    return false;
  },
  start() {
    return Promise.resolve();
  },
  update() {
    return Promise.resolve();
  },
  end() {
    return Promise.resolve();
  },
};

/**
 * Missing in Expo Go and in dev clients built before this local module landed.
 * Treat those binaries as unsupported rather than failing module evaluation.
 */
const PaseoLiveActivity: PaseoLiveActivityModule =
  requireOptionalNativeModule<PaseoLiveActivityModule>("PaseoLiveActivity") ?? unavailableModule;

export { PaseoLiveActivity };
export default PaseoLiveActivity;
