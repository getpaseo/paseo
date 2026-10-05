import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { type Author, authorAvatarUrl } from "./registry";

const SIZE_CLASS = {
  sm: "h-5 w-5 text-[10px]",
  lg: "h-14 w-14 text-xl",
} as const;

export function AuthorAvatar({ author, size }: { author: Author; size: keyof typeof SIZE_CLASS }) {
  const url = authorAvatarUrl(author);
  const className = `flex flex-shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/[0.06] font-medium text-white/60 ${SIZE_CLASS[size]}`;
  if (url) {
    return (
      <span className={className}>
        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
      </span>
    );
  }
  return (
    <span aria-hidden className={className}>
      {author.name.charAt(0).toUpperCase()}
    </span>
  );
}

const DEFAULT_CLASS =
  "inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors";

/** Link to the author's plugin list. Renders avatar and name unless children are given. */
export function AuthorLink({
  author,
  className = DEFAULT_CLASS,
  children,
}: {
  author: Author;
  className?: string;
  children?: ReactNode;
}) {
  const params = useMemo(() => ({ owner: author.username }), [author.username]);
  return (
    <Link to="/plugins/$owner" params={params} className={className}>
      {children ?? (
        <>
          <AuthorAvatar author={author} size="sm" />
          {author.name}
        </>
      )}
    </Link>
  );
}
