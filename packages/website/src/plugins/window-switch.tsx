import type { InstallWindow } from "./installs";

const WINDOWS: { value: InstallWindow; label: string }[] = [
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "all", label: "All time" },
];

/** Plain text time-window switch for install rankings. */
export function WindowSwitch({
  current,
  hrefs,
}: {
  current: InstallWindow;
  hrefs: Record<InstallWindow, string>;
}) {
  return (
    <nav aria-label="Time window" className="flex items-baseline gap-4 text-sm">
      {WINDOWS.map((option) => (
        <a
          key={option.value}
          href={hrefs[option.value]}
          aria-current={option.value === current ? "true" : undefined}
          className={
            option.value === current
              ? "text-foreground"
              : "text-extra-muted-foreground transition-colors hover:text-muted-foreground"
          }
        >
          {option.label}
        </a>
      ))}
    </nav>
  );
}
