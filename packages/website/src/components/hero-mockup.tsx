export function HeroMockup() {
  return (
    <div className="overflow-hidden rounded-xl bg-mock-surface0 p-2 ring-1 ring-white/10 sm:rounded-2xl sm:p-3">
      <img
        src="/homepage-hero.png"
        alt="Paseo desktop app with coding agents, a conversation, and a code diff open side by side"
        width={2400}
        height={1442}
        fetchPriority="high"
        decoding="async"
        className="block h-auto w-full rounded-lg sm:rounded-xl"
      />
    </div>
  );
}
