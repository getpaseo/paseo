import { useNavigate } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useRef, useState } from "react";
import { type BrowseQuery, browseHref, DEFAULT_WINDOW } from "./links";

const ICON_CLASS = "h-3.5 w-3.5 text-extra-muted-foreground";

/**
 * Search box for the plugin pages. Typing replaces the URL with the browse page for the term,
 * keeping `scope`'s category and sort. Without JavaScript the form submits the same URL.
 */
export function PluginSearch({ scope, className }: { scope: BrowseQuery; className?: string }) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState(scope.q ?? "");
  const search = useCallback(
    (next: string) => {
      setTerm(next);
      void navigate({
        href: browseHref({ ...scope, q: next.trim() ? next : undefined }),
        replace: true,
      });
    },
    [navigate, scope],
  );
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => search(event.target.value),
    [search],
  );
  const handleClear = useCallback(() => {
    search("");
    input.current?.focus();
  }, [search]);
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
      <div className="relative">
        <Search
          className={`pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 ${ICON_CLASS}`}
        />
        <input
          ref={input}
          type="search"
          name="q"
          value={term}
          onChange={handleChange}
          placeholder="Search plugins"
          aria-label="Search plugins"
          // Typing on the directory lands here; keep the caret in the box.
          autoFocus={Boolean(scope.q)}
          className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-1.5 pl-8 pr-8 text-sm text-foreground placeholder:text-extra-muted-foreground focus:border-white/20 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
        />
        {term && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 transition-colors hover:bg-white/[0.06]"
          >
            <X className={ICON_CLASS} />
          </button>
        )}
      </div>
    </form>
  );
}
