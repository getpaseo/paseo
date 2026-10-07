import { useNavigate, useRouter } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { type BrowseQuery, browseHref, DEFAULT_WINDOW, parseSearchTerm } from "./links";

const ICON_CLASS = "h-3.5 w-3.5 text-extra-muted-foreground";

/**
 * Search box for the plugin pages. Submitting opens the browse page for the term, keeping
 * `scope`'s category and sort. With `live`, typing filters in place instead: the first character
 * of a query pushes one history entry and later edits replace it, so Back leaves the search.
 * Without JavaScript the form submits the same URL.
 */
export function PluginSearch({
  scope,
  live = false,
  className,
}: {
  scope: BrowseQuery;
  live?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState(scope.q ?? "");
  // Back and Forward between results of the same page keep this box mounted; show their term.
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        if (action.type === "PUSH" || action.type === "REPLACE") return;
        setTerm(parseSearchTerm(new URLSearchParams(location.search).get("q")) ?? "");
      }),
    [router],
  );
  const show = useCallback(
    (next: string, { replace }: { replace: boolean }) => {
      void navigate({ href: browseHref({ ...scope, q: next.trim() ? next : undefined }), replace });
    },
    [navigate, scope],
  );
  const edit = useCallback(
    (next: string) => {
      setTerm(next);
      if (live) show(next, { replace: Boolean(term.trim()) });
    },
    [live, show, term],
  );
  // A term typed before the page hydrated is in the box but not in state; adopt it. Once hydrated,
  // the box always matches state, so this does nothing.
  useEffect(() => {
    const typed = input.current?.value ?? "";
    if (typed !== term) edit(typed);
  }, [edit, term]);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => edit(event.target.value),
    [edit],
  );
  const handleClear = useCallback(() => {
    edit("");
    input.current?.focus();
  }, [edit]);
  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      // Live results already show the term.
      if (!live) show(term, { replace: false });
    },
    [live, show, term],
  );
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
