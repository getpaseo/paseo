import { motion, useInView, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createMockupPlayer,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  MOCKUP_STATES,
  type MockupStateId,
  MockupWindow,
  ScaledMockup,
  useMockupScene,
} from "~/components/mockup";

const IN_VIEW = { once: true };
/** How far down the mockup its start line sits. */
const START_LINE = "60%";
/** The space left between the top or bottom of the window and the pills or the mockup. */
const PAGE_MARGIN = 16;
const START_LINE_STYLE = { top: START_LINE };
const PILL_TRANSITION = { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] as const };

export function HeroMockup() {
  const { t } = useTranslation();
  const [player] = useState(createMockupPlayer);
  const state = useMockupScene(player);

  // The opening scene plays once most of the mockup is on screen, so a visitor who scrolls to it
  // sees it from the start. "Most" is a line 60% of the way down the mockup. A window shorter than
  // 60% of the mockup still reaches the line, which a share of the mockup on screen would not.
  // With reduced motion there is nothing to miss, so the finished scene shows at once.
  const frame = useRef<HTMLDivElement>(null);
  const startLine = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const onScreen = useInView(startLine, IN_VIEW);
  const ready = onScreen || reduceMotion === true;
  useEffect(() => {
    if (ready) player.start();
  }, [ready, player]);
  useEffect(() => player.stop, [player]);

  // The pills can sit above a mockup that is partly below the fold, most of all on a phone.
  // Picking a scene brings the pills and the mockup on screen together. A window too short for
  // both keeps the pills at its top edge, so the next pill is still in reach.
  const select = useCallback(
    (scene: MockupStateId) => {
      player.select(scene);
      if (frame.current) scrollOnScreen(frame.current, reduceMotion ? "auto" : "smooth");
    },
    [player, reduceMotion],
  );

  return (
    <div ref={frame}>
      <div className="mb-4 flex flex-wrap items-center justify-center gap-1 sm:gap-2">
        {MOCKUP_STATES.map((option) => (
          <StatePill
            key={option}
            id={option}
            label={t(`landing.mockup.${option}`)}
            selected={option === state}
            onSelect={select}
          />
        ))}
      </div>

      <div className="relative">
        <div
          ref={startLine}
          aria-hidden="true"
          style={START_LINE_STYLE}
          className="pointer-events-none absolute inset-x-0 h-px"
        />
        <ScaledMockup
          width={DESIGN_WIDTH}
          height={DESIGN_HEIGHT}
          borderRadius={18}
          label={t("landing.mockup.alt")}
          className="ring-1 ring-white/10"
        >
          <MockupWindow player={player} />
        </ScaledMockup>
      </div>
    </div>
  );
}

/** Where an element sits in the window, from layout alone. A slide-in that is still running does not count. */
function layoutRect(element: HTMLElement) {
  let top = -window.scrollY;
  for (let node: Element | null = element; node instanceof HTMLElement; node = node.offsetParent) {
    top += node.offsetTop;
  }
  return { top, bottom: top + element.offsetHeight };
}

/**
 * Scrolls the least that shows all of an element, and never past the point where its top edge is
 * at the top of the window. The element is measured where it settles, because the hero slides up
 * as it enters and a click can come before it stops.
 */
function scrollOnScreen(element: HTMLElement, behavior: ScrollBehavior) {
  const { top, bottom } = layoutRect(element);
  const aboveWindow = top - PAGE_MARGIN;
  const belowWindow = bottom + PAGE_MARGIN - window.innerHeight;
  const distance = aboveWindow < 0 ? aboveWindow : Math.min(Math.max(belowWindow, 0), aboveWindow);
  if (distance !== 0) window.scrollBy({ top: distance, behavior });
}

function StatePill({
  id,
  label,
  selected,
  onSelect,
}: {
  id: MockupStateId;
  label: string;
  selected: boolean;
  onSelect: (id: MockupStateId) => void;
}) {
  const select = useCallback(() => onSelect(id), [onSelect, id]);
  return (
    <button
      type="button"
      onClick={select}
      aria-pressed={selected}
      className={`relative cursor-pointer rounded-full px-2.5 py-1.5 text-xs transition-colors sm:px-3.5 sm:text-sm ${
        selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {selected ? (
        <motion.span
          layoutId="hero-mockup-pill"
          transition={PILL_TRANSITION}
          className="absolute inset-0 rounded-full bg-white/8 ring-1 ring-white/12 ring-inset"
        />
      ) : null}
      <span className="relative">{label}</span>
    </button>
  );
}
