import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  HUB_TRIGGER_SOURCES,
  type HubTriggerSource,
  type HubTriggerSourceId,
} from "~/components/hub-flow";
import { DiscordSourceMockup } from "./discord-mockup";
import { GitHubSourceMockup } from "./github-mockup";
import { LinearSourceMockup } from "./linear-mockup";
import { SchedulesSourceMockup } from "./schedules-mockup";
import type { SourceMockupProps } from "./shared";
import { SlackSourceMockup } from "./slack-mockup";
import { WebhooksSourceMockup } from "./webhooks-mockup";

const SHOWCASE_ORDER: readonly HubTriggerSourceId[] = [
  "slack",
  "github",
  "linear",
  "discord",
  "schedules",
  "webhooks",
];

const SHOWCASE_SOURCES: readonly HubTriggerSource[] = SHOWCASE_ORDER.map((id) => {
  const source = HUB_TRIGGER_SOURCES.find((item) => item.id === id);
  if (!source) {
    throw new Error(`Missing Hub trigger source metadata for "${id}"`);
  }
  return source;
});

const SOURCE_MOCKUPS: Record<HubTriggerSourceId, React.ComponentType<SourceMockupProps>> = {
  slack: SlackSourceMockup,
  github: GitHubSourceMockup,
  linear: LinearSourceMockup,
  discord: DiscordSourceMockup,
  schedules: SchedulesSourceMockup,
  webhooks: WebhooksSourceMockup,
};

const ACTIVE_BAR_TRANSITION = { type: "spring", stiffness: 460, damping: 36 } as const;
const PANEL_INITIAL = { opacity: 0, y: 4 } as const;
const PANEL_ANIMATE = { opacity: 1, y: 0 } as const;
const PANEL_EXIT = { opacity: 0, y: -4 } as const;
const PANEL_TRANSITION = { duration: 0.16, ease: "easeOut" } as const;
const STAGE_IN_VIEW_OPTIONS = { once: true, margin: "-60px" } as const;

/**
 * Interactive split showcase for Paseo Hub automation sources:
 * left clickable pills on desktop (compact pill grid on mobile) paired with a fixed-height
 * right stage that swaps between authentic, animated dark-mode mockups with zero layout shift.
 */
export function HubAutomationsShowcase() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion() === true;
  const [selected, setSelected] = React.useState<HubTriggerSourceId>("slack");
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const tabRefs = React.useRef<Partial<Record<HubTriggerSourceId, HTMLButtonElement | null>>>({});
  const isInView = useInView(stageRef, STAGE_IN_VIEW_OPTIONS);

  const ActiveMockup = SOURCE_MOCKUPS[selected];

  const registerTabRef = React.useCallback(
    (id: HubTriggerSourceId, node: HTMLButtonElement | null) => {
      tabRefs.current[id] = node;
    },
    [],
  );

  const handleNavigate = React.useCallback((index: number, key: string): boolean => {
    let nextIndex: number | null = null;
    if (key === "ArrowDown" || key === "ArrowRight") {
      nextIndex = (index + 1) % SHOWCASE_SOURCES.length;
    } else if (key === "ArrowUp" || key === "ArrowLeft") {
      nextIndex = (index - 1 + SHOWCASE_SOURCES.length) % SHOWCASE_SOURCES.length;
    } else if (key === "Home") {
      nextIndex = 0;
    } else if (key === "End") {
      nextIndex = SHOWCASE_SOURCES.length - 1;
    }
    if (nextIndex === null) return false;
    const nextId = SHOWCASE_SOURCES[nextIndex].id;
    setSelected(nextId);
    tabRefs.current[nextId]?.focus();
    return true;
  }, []);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[264px_minmax(0,1fr)] lg:gap-7">
      <div className="space-y-2.5">
        <div
          role="tablist"
          aria-label={t("hub.demo.shared.tablistLabel")}
          className="grid grid-cols-3 gap-1.5 sm:gap-2 lg:flex lg:flex-col lg:gap-1.5"
        >
          {SHOWCASE_SOURCES.map((source, index) => (
            <SourceTabButton
              key={source.id}
              source={source}
              index={index}
              isSelected={source.id === selected}
              reduceMotion={reduceMotion}
              onSelect={setSelected}
              onNavigate={handleNavigate}
              registerRef={registerTabRef}
            />
          ))}
        </div>

        <p className="text-xs text-muted-foreground lg:hidden">
          {t(`hub.sources.${selected}.description`)}
        </p>
      </div>

      <figure ref={stageRef} className="min-w-0 space-y-3">
        <div className="relative lg:h-[528px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={selected}
              role="tabpanel"
              id={`hub-source-panel-${selected}`}
              aria-labelledby={`hub-source-tab-${selected}`}
              tabIndex={0}
              initial={reduceMotion ? false : PANEL_INITIAL}
              animate={PANEL_ANIMATE}
              exit={reduceMotion ? undefined : PANEL_EXIT}
              transition={PANEL_TRANSITION}
              className="h-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text"
            >
              <ActiveMockup active={isInView} reduceMotion={reduceMotion} />
            </motion.div>
          </AnimatePresence>
        </div>

        <figcaption className="min-h-[1.25rem] text-sm text-muted-foreground">
          {t(`hub.demo.${selected}.caption`)}
        </figcaption>
      </figure>
    </div>
  );
}

function SourceTabButton({
  source,
  index,
  isSelected,
  reduceMotion,
  onSelect,
  onNavigate,
  registerRef,
}: {
  source: HubTriggerSource;
  index: number;
  isSelected: boolean;
  reduceMotion: boolean;
  onSelect: (id: HubTriggerSourceId) => void;
  onNavigate: (index: number, key: string) => boolean;
  registerRef: (id: HubTriggerSourceId, node: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation();
  const { id, Icon } = source;

  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      registerRef(id, node);
    },
    [id, registerRef],
  );

  const handleClick = React.useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (onNavigate(index, event.key)) {
        event.preventDefault();
      }
    },
    [index, onNavigate],
  );

  return (
    <button
      ref={setRef}
      type="button"
      role="tab"
      id={`hub-source-tab-${id}`}
      aria-selected={isSelected}
      aria-controls={`hub-source-panel-${id}`}
      tabIndex={isSelected ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`group relative flex min-h-[42px] cursor-pointer items-center justify-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text lg:min-h-0 lg:items-start lg:justify-start lg:gap-3 lg:px-3.5 lg:py-3 ${
        isSelected
          ? "border-brand-green/55 bg-brand-green/[0.13] text-white"
          : "border-white/[0.07] bg-white/[0.015] text-white/70 hover:border-white/[0.14] hover:bg-white/[0.035] hover:text-white/90 lg:border-transparent lg:bg-transparent"
      }`}
    >
      {isSelected ? (
        <motion.span
          layoutId={reduceMotion ? undefined : "hub-source-active-bar"}
          transition={ACTIVE_BAR_TRANSITION}
          aria-hidden="true"
          className="pointer-events-none absolute top-2.5 bottom-2.5 left-0 hidden w-[3px] rounded-full bg-accent-text lg:block"
        />
      ) : null}

      <span
        className={`shrink-0 transition-colors lg:mt-0.5 ${
          isSelected ? "text-accent-text" : "text-white/55 group-hover:text-white/80"
        }`}
      >
        <Icon className="h-4 w-4 lg:h-[18px] lg:w-[18px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-xs font-medium lg:text-sm ${
            isSelected ? "text-white" : "text-white/80 group-hover:text-white"
          }`}
        >
          {t(`hub.sources.${id}.name`)}
        </span>
        <span
          className={`mt-0.5 hidden text-xs leading-snug lg:block ${
            isSelected ? "text-white/65" : "text-muted-foreground"
          }`}
        >
          {t(`hub.sources.${id}.description`)}
        </span>
      </span>
    </button>
  );
}
