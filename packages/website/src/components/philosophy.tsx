import { Blocks, Compass, Gem, Lock, Merge, Puzzle, type LucideIcon } from "lucide-react";

interface Principle {
  icon: LucideIcon;
  title: string;
  description: string;
}

const PRINCIPLES: ReadonlyArray<Principle> = [
  {
    icon: Lock,
    title: "Private",
    description:
      "No telemetry, tracking, or forced login. Code and credentials stay on your machines. The optional relay is end-to-end encrypted.",
  },
  {
    icon: Compass,
    title: "Independent",
    description:
      "Paseo doesn't answer to investors. It's open source under Apache 2.0, and feedback from the people who use it guides what gets built.",
  },
  {
    icon: Gem,
    title: "Polished by default",
    description:
      "Install the desktop app, scan a QR code to pair your phone, and start working. You don't need to know what a daemon or a relay is.",
  },
  {
    icon: Merge,
    title: "Unified",
    description:
      "Claude Code, Codex, OpenCode, Pi, and more in one app. Paseo handles the differences, so switching doesn't change how you work.",
  },
  {
    icon: Blocks,
    title: "Composable",
    description:
      "The daemon and clients are separate. Run agents on a laptop or server, and connect to them from desktop, phone, web, or the CLI.",
  },
  {
    icon: Puzzle,
    title: "Extensible",
    description:
      "Plugins add panels, commands, settings, providers, and themes. If Paseo doesn't fit how you work, change it, or ask your agent to.",
  },
];

/** Homepage: the principles Paseo is built on. */
export function PhilosophySection() {
  return (
    <section>
      <div className="mb-12 space-y-2">
        <p className="text-sm text-white/40">Philosophy</p>
        <h2 className="text-3xl font-medium tracking-tight">What Paseo stands for</h2>
        <p className="max-w-lg text-base text-pretty text-muted-foreground">
          The principles behind every decision in Paseo.
        </p>
      </div>
      <ul className="grid gap-x-8 gap-y-10 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-3">
        {PRINCIPLES.map((principle) => (
          <li key={principle.title} className="max-w-64">
            <principle.icon
              aria-hidden="true"
              className="mb-5 size-8 text-white/30"
              strokeWidth={1.25}
            />
            <h3 className="text-lg font-medium text-white/90">{principle.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/55">{principle.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
