import { motion } from "framer-motion";
import { useCallback, useState } from "react";
import {
  DEFAULT_MOCKUP_STATE,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  MOCKUP_STATES,
  type MockupStateId,
  MockupWindow,
  ScaledMockup,
} from "~/components/mockup";

const ALT =
  "Paseo desktop app with coding agents, a conversation, and a code diff open side by side";

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

      <ScaledMockup
        width={DESIGN_WIDTH}
        height={DESIGN_HEIGHT}
        borderRadius={18}
        label={ALT}
        className="ring-1 ring-white/10"
      >
        <MockupWindow state={state} />
      </ScaledMockup>
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
