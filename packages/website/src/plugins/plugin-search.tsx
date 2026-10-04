import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { type BrowseQuery, browseHref, DEFAULT_WINDOW } from "./links";

/**
 * Search box for the plugin pages. Typing replaces the URL with the browse page for the term,
 * keeping `scope`'s category and sort. Without JavaScript the form submits the same URL.
 */
export function PluginSearch({ scope, className }: { scope: BrowseQuery; className?: string }) {
  const navigate = useNavigate();
  const [term, setTerm] = useState(scope.q ?? "");
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setTerm(next);
      void navigate({
        href: browseHref({ ...scope, q: next.trim() ? next : undefined }),
        replace: true,
      });
    },
    [navigate, scope],
  );
  const handleSubmit = useCallback((event: FormEvent) => event.preventDefault(), []);
  return (
    <form
      role="search"
      method="get"
      action={browseHref({ ...scope, q: undefined, sort: "installs", window: DEFAULT_WINDOW })}
      onSubmit={handleSubmit}
      className={className}
    >
      {scope.sort === "new" && <input type="hidden" name="sort" value="new" />}
      {scope.sort === "installs" && scope.window !== DEFAULT_WINDOW && (
        <input type="hidden" name="window" value={scope.window} />
      )}
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-extra-muted-foreground" />
        <input
          type="search"
          name="q"
          value={term}
          onChange={handleChange}
          placeholder="Search plugins"
          aria-label="Search plugins"
          // Typing on the directory lands here; keep the caret in the box.
          autoFocus={Boolean(scope.q)}
          className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-extra-muted-foreground focus:border-white/20 focus:outline-none"
        />
      </label>
    </form>
  );
}
