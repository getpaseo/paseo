import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type DocsNavNode } from "~/docs";

interface DocsNavProps {
  nodes: DocsNavNode[];
  mobile?: boolean;
  onNavigate?: () => void;
}

const ACTIVE_OPTIONS_EXACT = { exact: true };

function nodeContainsHref(node: DocsNavNode, href: string): boolean {
  if (node.type === "page") return node.href === href;
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
  const [isOpen, setIsOpen] = useState(containsActive);
  const toggle = useCallback(() => setIsOpen((open) => !open), []);

  useEffect(() => {
    setIsOpen(containsActive);
  }, [containsActive]);

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className={clsx(
          "w-full flex items-center justify-between gap-2 px-3 py-2 text-sm rounded-md transition-colors",
          mobile
            ? "text-muted-foreground hover:text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-muted",
          containsActive && "text-foreground",
        )}
      >
        <span>{node.label}</span>
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {isOpen && (
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
