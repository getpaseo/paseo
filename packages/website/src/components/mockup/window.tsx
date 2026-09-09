import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "framer-motion";
import { AgentTranscript, Composer, PluginBuildTranscript } from "./chat";
import { DESIGN_HEIGHT, DESIGN_WIDTH, RIGHT_PANEL_W } from "./geometry";
import { FADE_IN, FADE_OUT, INSTANT_TRANSITION, MOCKUP_TRANSITION } from "./motion";
import { DiffReviewPane } from "./panes";
import { RightPanel } from "./right-panel";
import { Sidebar } from "./sidebar";
import { hasRightPanel, type MockupStateId } from "./states";
import { TabStrip, TitleBar } from "./titlebar";

const WINDOW_STYLE = { width: DESIGN_WIDTH, height: DESIGN_HEIGHT };
const PANEL_STYLE = { width: RIGHT_PANEL_W };
const PANEL_COLLAPSED = { width: 0, opacity: 0 };
const PANEL_OPEN = { width: RIGHT_PANEL_W + 1, opacity: 1 };

/** Which center pane a state shows. States sharing a key keep it mounted. */
function centerKey(state: MockupStateId): string {
  if (state === "review") return "review";
  if (state === "extend") return "extend";
  return "chat";
}

function panelKey(state: MockupStateId): string {
  if (state === "ship") return "ship";
  if (state === "extend") return "extend";
  return "changes";
}

function CenterPane({ state }: { state: MockupStateId }) {
  if (state === "review") return <DiffReviewPane />;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mock-surface0">
      {/* Bottom-anchored: the newest turn sits on the composer, older text clips. */}
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-[27px] pb-[6px]">
        {state === "extend" ? <PluginBuildTranscript /> : <AgentTranscript />}
      </div>
      <Composer showProgress={state !== "extend"} busy={state !== "extend"} />
    </div>
  );
}

/** The docked panel keeps its width while its contents swap. */
function PanelCrossfade({ state }: { state: MockupStateId }) {
  return (
    <div className="relative" style={PANEL_STYLE}>
      <AnimatePresence initial={false}>
        <motion.div
          key={panelKey(state)}
          initial={FADE_OUT}
          animate={FADE_IN}
          exit={FADE_OUT}
          className="absolute inset-0"
        >
          <RightPanel state={state} />
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
            key={centerKey(state)}
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

/** The docked right panel, animating its width open and closed. */
function DockedPanel({ state }: { state: MockupStateId }) {
  return (
    <motion.div
      initial={PANEL_COLLAPSED}
      animate={PANEL_OPEN}
      exit={PANEL_COLLAPSED}
      className="relative flex shrink-0 overflow-hidden"
    >
      <div className="w-px shrink-0 bg-mock-border" />
      <PanelCrossfade state={state} />
    </motion.div>
  );
}

export function MockupWindow({ state }: { state: MockupStateId }) {
  const reduceMotion = useReducedMotion();

  return (
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
      </div>
    </MotionConfig>
  );
}
