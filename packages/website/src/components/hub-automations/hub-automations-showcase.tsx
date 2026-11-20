import { useInView, useReducedMotion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  HUB_TRIGGER_SOURCES,
  type HubTriggerSource,
  type HubTriggerSourceId,
} from "~/components/hub-flow";
import { useLocalizePath } from "~/i18n";
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

const SOURCE_DOC_PATHS: Record<HubTriggerSourceId, string> = {
  slack: "/docs/hub/triggers/slack",
  github: "/docs/hub/triggers/github",
  linear: "/docs/hub/triggers/linear",
  discord: "/docs/hub/triggers/discord",
  schedules: "/docs/hub/triggers/schedules",
  webhooks: "/docs/hub/triggers/webhooks",
};

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

const STAGE_IN_VIEW_OPTIONS = { once: true, margin: "-60px" } as const;
const PANEL_ID = "hub-source-panel";

/**
 * Interactive split showcase for Paseo Hub automation sources:
 * left clickable pills on desktop (compact pill grid on mobile) paired with a fixed-height
 * right stage that swaps between authentic, animated dark-mode mockups with zero layout shift.
 */
export function HubAutomationsShowcase() {
  const { t } = useTranslation();
  const localize = useLocalizePath();
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
    <div className="grid items-start gap-6 lg:grid-cols-[292px_minmax(0,1fr)] lg:gap-6">
      <div className="space-y-2.5">
        <div
          role="tablist"
          aria-label={t("hub.demo.shared.tablistLabel")}
          className="grid grid-cols-2 gap-1.5 min-[375px]:grid-cols-3 sm:gap-2 lg:flex lg:flex-col lg:gap-1.5"
        >
          {SHOWCASE_SOURCES.map((source, index) => (
            <SourceTabButton
              key={source.id}
              source={source}
              index={index}
              isSelected={source.id === selected}
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
        <div
          role="tabpanel"
          id={PANEL_ID}
          aria-labelledby={`hub-source-tab-${selected}`}
          tabIndex={0}
          className="relative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text lg:h-[33rem]"
        >
          <ActiveMockup active={isInView} reduceMotion={reduceMotion} />
        </div>

        <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1.5 min-h-[1.25rem] text-sm text-muted-foreground">
          <span>{t(`hub.demo.${selected}.caption`)}</span>
          <a
            href={localize(SOURCE_DOC_PATHS[selected])}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm text-white/75 transition-colors hover:text-accent-text"
          >
            {t("hub.demo.shared.docsLink", { source: t(`hub.sources.${selected}.name`) })}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </figcaption>
      </figure>
    </div>
  );
}

function SourceTabButton({
  source,
  index,
  isSelected,
  onSelect,
  onNavigate,
  registerRef,
}: {
  source: HubTriggerSource;
  index: number;
  isSelected: boolean;
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
      aria-controls={PANEL_ID}
      tabIndex={isSelected ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`group flex min-h-[42px] cursor-pointer items-center justify-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-text lg:min-h-0 lg:items-start lg:justify-start lg:gap-3 lg:px-3.5 lg:py-3 ${
        isSelected
          ? "border-brand-green/55 bg-brand-green/[0.13] text-white"
          : "border-white/[0.07] bg-white/[0.015] text-white/70 hover:border-white/[0.14] hover:bg-white/[0.035] hover:text-white/90 lg:border-transparent lg:bg-transparent"
      }`}
    >
      <span
        className={`shrink-0 transition-colors lg:mt-0.5 ${
          isSelected ? "text-accent-text" : "text-white/55 group-hover:text-white/80"
        }`}
      >
        <Icon className="h-4 w-4 lg:h-[18px] lg:w-[18px]" />
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={`block text-xs leading-5 font-medium wrap-anywhere lg:text-sm ${
            isSelected ? "text-white" : "text-white/80 group-hover:text-white"
          }`}
        >
          {t(`hub.sources.${id}.name`)}
        </span>
        <span
          className={`mt-0.5 hidden text-xs leading-4 wrap-anywhere lg:block ${
            isSelected ? "text-white/65" : "text-muted-foreground"
          }`}
        >
          {t(`hub.sources.${id}.description`)}
        </span>
      </span>
    </button>
  );
}
