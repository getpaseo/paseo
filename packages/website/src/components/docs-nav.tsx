import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import { type DocsNavNode } from "~/docs";

interface DocsNavProps {
  nodes: DocsNavNode[];
  mobile?: boolean;
  onNavigate?: () => void;
}

const ACTIVE_OPTIONS_EXACT = { exact: true };

function nodeContainsHref(node: DocsNavNode, href: string): boolean {
  if (node.type === "page") return node.href === href;
  if (node.type === "group" && node.href === href) return true;
  return node.children.some((child) => nodeContainsHref(child, href));
}

function clsx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

function PageLink({
  node,
  mobile,
  onNavigate,
}: {
  node: Extract<DocsNavNode, { type: "page" }>;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const isActive = location.pathname === node.href;

  return (
    <Link
      to={node.href}
      activeOptions={ACTIVE_OPTIONS_EXACT}
      onClick={onNavigate}
      data-docs-nav-active={isActive ? "" : undefined}
      className={clsx(
        "block px-3 py-2 text-sm rounded-md transition-colors",
        mobile
          ? "text-muted-foreground hover:text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
        isActive && (mobile ? "text-foreground" : "bg-muted text-foreground"),
      )}
    >
      {node.label}
    </Link>
  );
}

function GroupNode({
  node,
  mobile,
  onNavigate,
}: {
  node: Extract<DocsNavNode, { type: "group" }>;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const currentHref = location.pathname;
  const containsActive = useMemo(() => nodeContainsHref(node, currentHref), [node, currentHref]);
  const isActive = node.href === currentHref;
  const [isOpen, setIsOpen] = useState(containsActive);
  const toggle = useCallback(() => setIsOpen((open) => !open), []);

  // Navigating into a group opens it. Navigating away must not close it, or a
  // group you opened to browse collapses the moment you click something else.
  useEffect(() => {
    if (containsActive) setIsOpen(true);
  }, [containsActive]);

  // The row is one target: it takes you to the group's page and opens it.
  // Clicking it again once you are already there collapses it.
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (isActive) {
        event.preventDefault();
        toggle();
        return;
      }
      setIsOpen(true);
      onNavigate?.();
    },
    [isActive, onNavigate, toggle],
  );

  const hasChildren = node.children.length > 0;
  const chevron = isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />;
  const rowClassName = clsx(
    "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-md transition-colors text-left",
    mobile
      ? "text-muted-foreground hover:text-foreground"
      : "text-muted-foreground hover:text-foreground hover:bg-muted",
    containsActive && "text-foreground",
    isActive && !mobile && "bg-muted",
  );

  return (
    <div>
      {node.href === undefined ? (
        <button type="button" onClick={toggle} aria-expanded={isOpen} className={rowClassName}>
          <span>{node.label}</span>
          {hasChildren && chevron}
        </button>
      ) : (
        <Link
          to={node.href}
          activeOptions={ACTIVE_OPTIONS_EXACT}
          onClick={handleClick}
          aria-expanded={hasChildren ? isOpen : undefined}
          data-docs-nav-active={isActive ? "" : undefined}
          className={rowClassName}
        >
          <span>{node.label}</span>
          {hasChildren && chevron}
        </Link>
      )}
      {isOpen && hasChildren && (
        <div className="ml-3 pl-3 border-l border-border space-y-0.5">
          <NavTree nodes={node.children} mobile={mobile} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

function CategoryNode({
  node,
  mobile,
  onNavigate,
}: {
  node: Extract<DocsNavNode, { type: "category" }>;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className={mobile ? "space-y-1" : "space-y-1 mt-6 first:mt-0"}>
      <div className="px-3 py-2 text-xs font-medium text-foreground">{node.label}</div>
      <NavTree nodes={node.children} mobile={mobile} onNavigate={onNavigate} />
    </div>
  );
}

function NavTree({ nodes, mobile, onNavigate }: DocsNavProps) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === "category") {
          return (
            <CategoryNode
              key={`category-${node.label}`}
              node={node}
              mobile={mobile}
              onNavigate={onNavigate}
            />
          );
        }
        if (node.type === "group") {
          return (
            <GroupNode
              key={`group-${node.segment}`}
              node={node}
              mobile={mobile}
              onNavigate={onNavigate}
            />
          );
        }
        return (
          <PageLink key={`page-${node.href}`} node={node} mobile={mobile} onNavigate={onNavigate} />
        );
      })}
    </div>
  );
}

export function DocsNav({ nodes, mobile, onNavigate }: DocsNavProps) {
  return (
    <div className={mobile ? undefined : "-ml-3"}>
      <NavTree nodes={nodes} mobile={mobile} onNavigate={onNavigate} />
    </div>
  );
}
