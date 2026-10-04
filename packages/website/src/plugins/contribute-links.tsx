import { BUILD_URL, SUBMIT_URL } from "./links";

const LINK_CLASS = "text-sm text-muted-foreground transition-colors hover:text-foreground";

/** "Build a plugin" and "Submit a plugin", as two quiet links. */
export function ContributeLinks({ className = LINK_CLASS }: { className?: string }) {
  return (
    <>
      <a href={BUILD_URL} className={className}>
        Build a plugin
      </a>
      <a href={SUBMIT_URL} className={className}>
        Submit a plugin
      </a>
    </>
  );
}
