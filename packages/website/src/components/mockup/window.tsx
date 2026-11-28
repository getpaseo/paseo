import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "framer-motion";
import type * as React from "react";
import { useMemo } from "react";
import {
  AgentTranscript,
  Composer,
  ProgressTrack,
  ScriptedComposer,
  ScriptedTranscript,
  SubagentsTrack,
} from "./chat";
import { DESIGN_HEIGHT, DESIGN_WIDTH } from "./geometry";
import { HostsModal } from "./hosts";
import { FADE_IN, FADE_OUT, INSTANT_TRANSITION, MOCKUP_TRANSITION } from "./motion";
import { ORCHESTRATION } from "./orchestration";
import { DiffReviewPane, RemoteTerminalPane } from "./panes";
import {
  createScenePlayer,
  type ScenePlayer,
  ScenePlayerContext,
  usePlayerScene,
  useSceneClock,
} from "./player";
import { PLUGIN_BUILD, pluginInstalled } from "./plugin-build";
import { REVIEW } from "./review";
import type { ProviderId } from "./providers";
import { type PanelId, panelWidth, RightPanel } from "./right-panel";
import type { SceneScript } from "./script";
import { Sidebar } from "./sidebar";
import { DEFAULT_MOCKUP_STATE, hasRightPanel, type MockupStateId } from "./states";
import { TabStrip, TitleBar } from "./titlebar";

const WINDOW_STYLE = { width: DESIGN_WIDTH, height: DESIGN_HEIGHT };
const PANEL_COLLAPSED = { width: 0, opacity: 0 };

/** Which panel is docked on the right. The plugin's panel exists once the plugin is installed. */
function dockedPanel(state: MockupStateId, pluginIsInstalled: boolean): PanelId {
  if (state === "ship") return "ship";
  if (state === "extend" && pluginIsInstalled) return "plugin";
  return "changes";
}

// Elements passed as props are hoisted so they are not rebuilt on every render.
const PROGRESS_TRACK = <ProgressTrack />;

/** The scenes that play a script, with the agent the user talks to and that agent's composer track. */
const SCRIPTED_SCENES: Partial<
  Record<MockupStateId, { script: SceneScript; agent: ProviderId; track?: React.ReactNode }>
> = {
  orchestrate: { script: ORCHESTRATION, agent: "claude", track: <SubagentsTrack /> },
  extend: { script: PLUGIN_BUILD, agent: "codex" },
};

/** A player for the mockup's scenes. It opens on the default scene. */
export function createMockupPlayer(): ScenePlayer {
  return createScenePlayer(DEFAULT_MOCKUP_STATE, {
    orchestrate: ORCHESTRATION.duration,
    extend: PLUGIN_BUILD.duration,
    review: REVIEW.duration,
  });
}

export { usePlayerScene as useMockupScene };

/** What the agent tab in front says in each scene. */
function Transcript({ state }: { state: MockupStateId }) {
  const scripted = SCRIPTED_SCENES[state];
  if (scripted) return <ScriptedTranscript scene={state} script={scripted.script} />;
  return <AgentTranscript />;
}

/** The composer under that transcript: whose agent it is, its track, and whether a turn runs. */
function ChatComposer({ state }: { state: MockupStateId }) {
  const scripted = SCRIPTED_SCENES[state];
  if (scripted) {
    return (
      <ScriptedComposer
        scene={state}
        script={scripted.script}
        agent={scripted.agent}
        track={scripted.track}
      />
    );
  }
  return <Composer track={PROGRESS_TRACK} />;
}

function CenterPane({ state }: { state: MockupStateId }) {
  if (state === "review") return <DiffReviewPane />;
  if (state === "remote") return <RemoteTerminalPane />;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mock-surface0">
      {/* A chat scrolls like this: a short transcript starts at the top, and one taller than the
          pane keeps its newest turn on the composer while older text clips. The reversed column
          pins the bottom, and the auto margin lifts a short transcript to the top. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-hidden px-[27px] pt-[12px] pb-[6px]">
        <div className="mb-auto">
          <Transcript state={state} />
        </div>
      </div>
      <ChatComposer state={state} />
    </div>
  );
}

/** The docked panel's contents cross-fade when the panel it shows changes. */
function PanelCrossfade({ panel }: { panel: PanelId }) {
  return (
    <div className="relative min-w-0 flex-1">
      <AnimatePresence initial={false}>
        {/* Each panel keeps its own width and the dock clips it, so nothing inside a panel
            reflows while the dock resizes. */}
        <motion.div
          key={panel}
          initial={FADE_OUT}
          animate={FADE_IN}
          exit={FADE_OUT}
          className="absolute inset-y-0 left-0"
        >
          <RightPanel panel={panel} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** The middle content column: its own header, then the tab strip, then the pane. */
function CenterColumn({ state }: { state: MockupStateId }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <TitleBar state={state} />
      <TabStrip state={state} />
      <div className="relative min-h-0 flex-1">
        <AnimatePresence initial={false}>
          <motion.div
            key={state}
            initial={FADE_OUT}
            animate={FADE_IN}
            exit={FADE_OUT}
            className="absolute inset-0 flex flex-col"
          >
            <CenterPane state={state} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** The docked right panel. Its width follows the panel it shows, plus one pixel for the divider. */
function DockedPanel({ state }: { state: MockupStateId }) {
  const panel = dockedPanel(state, useSceneClock("extend", pluginInstalled));
  const open = useMemo(() => ({ width: panelWidth(panel) + 1, opacity: 1 }), [panel]);
  return (
    <motion.div
      initial={PANEL_COLLAPSED}
      animate={open}
      exit={PANEL_COLLAPSED}
      className="relative flex shrink-0 overflow-hidden"
    >
      <div className="w-px shrink-0 bg-mock-border" />
      <PanelCrossfade panel={panel} />
    </motion.div>
  );
}

export function MockupWindow({ player }: { player: ScenePlayer }) {
  const reduceMotion = useReducedMotion();
  const state = usePlayerScene(player);

  return (
    <ScenePlayerContext value={player}>
      <MotionConfig transition={reduceMotion ? INSTANT_TRANSITION : MOCKUP_TRANSITION}>
        <div
          className="relative flex select-none overflow-hidden bg-mock-surface0 text-mock-fg antialiased"
          style={WINDOW_STYLE}
        >
          {/* Three full-height columns, each owning its own header. The middle
            header stops at the divider — it never spans over the right panel. */}
          <Sidebar state={state} />
          <div className="w-px shrink-0 bg-mock-border" />
          <CenterColumn state={state} />
          <AnimatePresence initial={false}>
            {hasRightPanel(state) ? <DockedPanel key="right-panel" state={state} /> : null}
          </AnimatePresence>
          {/* The remote scene opens the hosts modal over the whole window, as the app dims
            everything behind a modal. */}
          <AnimatePresence initial={false}>
            {state === "remote" ? (
              <motion.div
                key="hosts-modal"
                initial={FADE_OUT}
                animate={FADE_IN}
                exit={FADE_OUT}
                className="absolute inset-0 flex items-center justify-center bg-black/55"
              >
                <HostsModal />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </MotionConfig>
    </ScenePlayerContext>
  );
}
