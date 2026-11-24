import { DiffRows, type LineReview, REVIEW_DIFF_ROWS, ScopeRow } from "./diff";
import { AddCommentAction, ReviewFeedback, ReviewThread } from "./review-thread";
import { useTranslation } from "react-i18next";

// --- review -----------------------------------------------------------------

const LINE_REVIEW: LineReview = { action: <AddCommentAction />, thread: <ReviewThread /> };

/**
 * The selected Changes-tree file, open in its own workspace tab. The review scene comments on one
 * of its lines and sends that feedback to an agent.
 */
export function DiffReviewPane() {
  const { t } = useTranslation();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-mock-surface0">
      <ScopeRow label={t("landing.mockup.app.uncommitted")} />
      <DiffRows rows={REVIEW_DIFF_ROWS} review={LINE_REVIEW} />
      <ReviewFeedback />
    </div>
  );
}

// --- remote -----------------------------------------------------------------

function ShellPrompt() {
  return (
    <>
      <span className="text-mock-term-green">mo@devbox</span>:
      <span className="text-mock-term-blue">~/dev/paseo</span>${" "}
    </>
  );
}

function ViteArrow() {
  return <span className="text-mock-term-green">{"  ➜  "}</span>;
}

function HmrLine({ time, file }: { time: string; file: string }) {
  return (
    <div>
      <span className="text-mock-fg-xmuted">{time}</span>{" "}
      <span className="text-mock-term-cyan">[vite]</span>{" "}
      <span className="text-mock-term-green">hmr update</span>{" "}
      <span className="text-mock-fg-muted">{file}</span>
    </div>
  );
}

/**
 * The workspace's terminal tab. The workspace lives on devbox, so the shell does too: the prompt
 * names the remote machine while the pane sits in the same window as every local workspace.
 */
export function RemoteTerminalPane() {
  return (
    <div className="min-h-0 flex-1 overflow-hidden whitespace-pre bg-mock-surface0 px-[16px] py-[12px] font-mono text-[12px] leading-[18.5px] text-mock-fg">
      <div>
        <ShellPrompt />
        npm run dev
      </div>
      <div> </div>
      <div className="text-mock-fg-muted">&gt; @getpaseo/website dev</div>
      <div className="text-mock-fg-muted">&gt; vite</div>
      <div> </div>
      <div>
        {"  "}
        <span className="text-mock-term-green">VITE v7.3.3</span>
        <span className="text-mock-fg-muted">{"  ready in "}</span>412 ms
      </div>
      <div> </div>
      <div>
        <ViteArrow />
        {"Local:   "}
        <span className="text-mock-term-cyan">http://localhost:3000/</span>
      </div>
      <div className="text-mock-fg-muted">
        <ViteArrow />
        press h + enter to show help
      </div>
      <div> </div>
      <HmrLine time="6:53:12 PM" file="/src/components/hero-mockup.tsx" />
      <HmrLine time="6:53:40 PM" file="/src/components/mockup/window.tsx" />
      <HmrLine time="6:54:07 PM" file="/src/styles.css" />
    </div>
  );
}
