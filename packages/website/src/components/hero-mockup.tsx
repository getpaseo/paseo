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

const IN_VIEW = { once: true, amount: 0.6 };
const PILL_TRANSITION = { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] as const };

export function HeroMockup() {
  const { t } = useTranslation();
  const [player] = useState(createMockupPlayer);
  const state = useMockupScene(player);

  // The opening scene plays once most of the mockup is on screen, so a visitor who scrolls to it
  // sees it from the start. With reduced motion there is nothing to miss, so the finished scene
  // shows at once.
  const frame = useRef<HTMLDivElement>(null);
  const mockup = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const onScreen = useInView(mockup, IN_VIEW);
  const ready = onScreen || reduceMotion === true;
  useEffect(() => (ready ? player.start() : undefined), [ready, player]);

  // The pills can sit above a mockup that is partly below the fold, most of all on a phone.
  // Picking a scene brings the pills and the mockup on screen together. A window too short for
  // both keeps the pills at its top edge, so the next pill is still in reach.
  const select = useCallback(
    (scene: MockupStateId) => {
      player.select(scene);
      frame.current?.scrollIntoView({
        block: "nearest",
        behavior: reduceMotion ? "auto" : "smooth",
      });
    },
    [player, reduceMotion],
  );

  return (
    <div ref={frame} className="scroll-my-4">
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

      <div ref={mockup}>
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
