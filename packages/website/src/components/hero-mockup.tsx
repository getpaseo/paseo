import { motion } from "framer-motion";
import { useCallback, useState } from "react";
import {
  DEFAULT_MOCKUP_STATE,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  MOCKUP_STATES,
  type MockupStateId,
  MockupWindow,
} from "~/components/mockup";

const ALT =
  "Paseo desktop app with coding agents, a conversation, and a code diff open side by side";

const ASPECT_STYLE = { aspectRatio: `${DESIGN_WIDTH} / ${DESIGN_HEIGHT}` };

// `tan(atan2(a, b))` is the CSS way to divide one length by another, so the scale
// factor tracks the container with no JS, no layout thrash, and a correct
// server-rendered first paint.
const SCALE_STYLE = {
  width: DESIGN_WIDTH,
  height: DESIGN_HEIGHT,
  transform: `scale(tan(atan2(100cqw, ${DESIGN_WIDTH}px)))`,
};

const PILL_TRANSITION = { duration: 0.34, ease: [0.22, 0.61, 0.36, 1] as const };

export function HeroMockup() {
  const [state, setState] = useState<MockupStateId>(DEFAULT_MOCKUP_STATE);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-center gap-1 sm:gap-2">
        {MOCKUP_STATES.map((option) => (
          <StatePill
            key={option.id}
            id={option.id}
            label={option.label}
            selected={option.id === state}
            onSelect={setState}
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-xl ring-1 ring-white/10 sm:rounded-2xl">
        {/* The window is authored at DESIGN_WIDTH and scaled to fit the hero column. */}
        <div className="w-full [container-type:inline-size]">
          <div
            className="relative w-full overflow-hidden rounded-xl sm:rounded-2xl"
            style={ASPECT_STYLE}
            role="img"
            aria-label={ALT}
          >
            <div className="absolute top-0 left-0 origin-top-left" style={SCALE_STYLE}>
              <MockupWindow state={state} />
            </div>
          </div>
        </div>
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
