import { useCallback, useEffect, useState } from "react";
import { type DocHeading } from "~/docs";

interface DocsOutlineProps {
  headings: DocHeading[];
}

function clsx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

function OutlineLink({
  heading,
  active,
  onActivate,
}: {
  heading: DocHeading;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const element = document.getElementById(heading.id);
      if (element) {
        element.scrollIntoView({ behavior: "smooth" });
        window.history.replaceState(null, "", `#${heading.id}`);
        onActivate(heading.id);
      }
    },
    [heading.id, onActivate],
  );

  return (
    <a
      href={`#${heading.id}`}
      onClick={handleClick}
      className={clsx(
        "block py-1 transition-colors border-l-2 -ml-px",
        heading.depth === 2 && "pl-3",
        heading.depth === 3 && "pl-6",
        heading.depth >= 4 && "pl-9",
        active
          ? "text-foreground border-primary"
          : "text-muted-foreground hover:text-foreground border-transparent",
      )}
    >
      {heading.text}
    </a>
  );
}

export function DocsOutline({ headings }: DocsOutlineProps) {
  const [activeId, setActiveId] = useState<string | null>(() =>
    headings.length > 0 ? headings[0].id : null,
  );

  useEffect(() => {
    setActiveId(headings.length > 0 ? headings[0].id : null);
  }, [headings]);

  useEffect(() => {
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target.id);
        if (visible.length > 0) {
          setActiveId(visible[0]);
        }
      },
      {
        rootMargin: "-10% 0px -70% 0px",
        threshold: 0,
      },
    );

    for (const heading of headings) {
      const element = document.getElementById(heading.id);
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav
      aria-label="On this page"
      className="sticky top-8 max-h-[calc(100vh-4rem)] overflow-y-auto py-8 pr-4"
    >
      <div className="text-xs font-medium text-muted-foreground mb-3 px-3">On this page</div>
      <ul className="space-y-1 border-l border-border">
        {headings.map((heading) => (
          <li key={heading.id} className="text-sm">
            <OutlineLink
              heading={heading}
              active={activeId === heading.id}
              onActivate={setActiveId}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}
