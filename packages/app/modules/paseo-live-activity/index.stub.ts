import type { PaseoLiveActivityModule } from "./types";

export type {
  LiveActivityContentState,
  LiveActivityHeroState,
  PaseoLiveActivityModule,
} from "./types";

/** Android and web intentionally ship no native implementation in v1. */
const PaseoLiveActivity: PaseoLiveActivityModule = {
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

export { PaseoLiveActivity };
export default PaseoLiveActivity;
