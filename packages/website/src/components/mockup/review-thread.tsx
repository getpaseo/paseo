import { AnimatePresence, motion } from "framer-motion";
import { CircleCheck, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Caret } from "./atoms";
import { FADE_IN, FADE_OUT, MOCKUP_TRANSITION } from "./motion";
import { useSceneClock } from "./player";
import { Pointer } from "./pointer";
import { PROVIDERS, type ProviderId } from "./providers";
import {
  ADD_COMMENT_CLICK,
  lineHovered,
  RECIPIENT_CLICK,
  recipientHovered,
  REVIEW,
  REVIEW_COMMENT,
  reviewPhase,
  SEND_FEEDBACK_CLICK,
} from "./review";

// The review scene, drawn like the app's review module (`packages/app/src/review`): the add
// button of a hovered line, the inline editor, the saved comment, and Send feedback.

// --- on the line ------------------------------------------------------------

const POINTER_TO_LINE = { x: 240, y: 150 };

/**
 * The add button a hovered line shows across its gutter's edge, and the pointer that clicks it.
 * Goes in the line's gutter.
 */
export function AddCommentAction() {
  const hovered = useSceneClock("review", lineHovered);
  const pressed = useSceneClock("review", ADD_COMMENT_CLICK.pressed);
  return (
    <span className="absolute top-1/2 -right-[10px] z-10 size-[20px] -translate-y-1/2">
      {hovered ? (
        <span
          className={`flex size-full items-center justify-center rounded-[5px] bg-mock-accent text-white ${
            pressed ? "brightness-90" : ""
          }`}
        >
          <Plus size={14} strokeWidth={2.4} />
        </span>
      ) : null}
      <Pointer
        scene="review"
        click={ADD_COMMENT_CLICK}
        from={POINTER_TO_LINE}
        className="top-1/2 left-1/2"
      />
    </span>
  );
}

function CommentEditor() {
  const { t } = useTranslation();
  const body = useSceneClock("review", REVIEW.draft);
  return (
    <div className="flex h-[94px] flex-col gap-[10px] rounded-[8px] border border-mock-border-accent bg-mock-surface2 p-[10px]">
      <div className="flex h-[34px] shrink-0 items-center rounded-[6px] border border-mock-accent bg-mock-surface1 px-[11px] text-[13px]">
        {body ? (
          <span className="text-mock-fg">
            {body}
            <Caret className="ml-px" />
          </span>
        ) : (
          <span className="text-mock-fg-muted">
            <Caret className="-mr-px" />
            {t("landing.mockup.app.reviewCommentPlaceholder")}
          </span>
        )}
      </div>
      <div className="flex items-center justify-end gap-[8px] text-[12px] leading-[18px]">
        <span className="px-[10px] py-[5px] text-mock-fg-muted">
          {t("landing.mockup.app.reviewCancel")}
        </span>
        <span
          className={`rounded-[6px] bg-mock-accent px-[11px] py-[5px] text-white ${
            body ? "" : "opacity-50"
          }`}
        >
          {t("landing.mockup.app.reviewSave")}
        </span>
      </div>
    </div>
  );
}

function SavedComment() {
  return (
    <div className="flex h-[42px] items-center gap-[12px] rounded-[8px] border border-mock-border-accent bg-mock-surface2 px-[12px]">
      <span className="min-w-0 flex-1 truncate text-[13px] text-mock-fg">{REVIEW_COMMENT}</span>
      <Pencil size={13} className="shrink-0 text-mock-fg-muted" />
      <Trash2 size={13} className="shrink-0 text-mock-destructive" />
    </div>
  );
}

// The thread is as tall as what it holds plus 8 of padding above and below.
const THREAD_CLOSED = { height: 0, opacity: 0 };
const THREAD_WRITING = { height: 110, opacity: 1 };
const THREAD_COMMENTED = { height: 58, opacity: 1 };

/** The comment thread under the line: the editor first, then the saved comment until it is sent. */
export function ReviewThread() {
  const phase = useSceneClock("review", reviewPhase);
  const writing = phase === "writing";
  const open = writing || phase === "commented" || phase === "choosing";
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={THREAD_CLOSED}
          animate={writing ? THREAD_WRITING : THREAD_COMMENTED}
          exit={THREAD_CLOSED}
          transition={MOCKUP_TRANSITION}
          className="overflow-hidden"
        >
          <div className="px-[12px] py-[8px]">{writing ? <CommentEditor /> : <SavedComment />}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// --- over the diff ----------------------------------------------------------

function RecipientRow({ agent, lit = false }: { agent: ProviderId; lit?: boolean }) {
  const provider = PROVIDERS[agent];
  return (
    <span
      className={`flex h-[30px] items-center gap-[8px] rounded-[6px] px-[9px] text-[13px] whitespace-nowrap text-mock-fg ${
        lit ? "bg-mock-surface2" : ""
      }`}
    >
      <span className="text-mock-fg-muted">
        <provider.Icon size={13} />
      </span>
      {provider.name}
    </span>
  );
}

/** Who gets the feedback. The workspace has two agent tabs, so Send feedback asks which one. */
const RECIPIENT: ProviderId = "codex";

// Where the pointer sets off for Send feedback, and how far the picked agent's row is from there.
// The button is 32 high. The list floats 6 above it, with 4 of padding around two rows of 30.
const POINTER_TO_SEND = { x: -190, y: -170 };
const POINTER_TO_RECIPIENT = { x: -6, y: 73 };

const FLOATING = "pointer-events-none absolute inset-x-0 bottom-[16px] flex justify-center";
const FLOATING_SHADOW = "shadow-[0_8px_24px_rgba(0,0,0,0.4)]";

/**
 * What floats over the bottom of the diff: Send feedback while a comment waits, the list of
 * agents it opens, and the toast that says who got the feedback.
 */
export function ReviewFeedback() {
  const { t } = useTranslation();
  const phase = useSceneClock("review", reviewPhase);
  const pressed = useSceneClock("review", SEND_FEEDBACK_CLICK.pressed);
  const recipientLit = useSceneClock("review", recipientHovered);
  return (
    <>
      <AnimatePresence initial={false}>
        {phase === "commented" || phase === "choosing" ? (
          <motion.div
            key="send"
            initial={FADE_OUT}
            animate={FADE_IN}
            exit={FADE_OUT}
            className={FLOATING}
          >
            <span className="relative">
              {phase === "choosing" ? (
                <motion.span
                  initial={FADE_OUT}
                  animate={FADE_IN}
                  className={`absolute bottom-full left-1/2 mb-[6px] block -translate-x-1/2 rounded-[9px] border border-mock-border-accent bg-mock-surface1 p-[4px] ${FLOATING_SHADOW}`}
                >
                  <RecipientRow agent={RECIPIENT} lit={recipientLit} />
                  <RecipientRow agent="claude" />
                </motion.span>
              ) : null}
              <span
                className={`flex h-[32px] items-center gap-[7px] rounded-[8px] bg-mock-accent px-[13px] text-[13px] whitespace-nowrap text-white ${FLOATING_SHADOW} ${
                  pressed ? "brightness-90" : ""
                }`}
              >
                <Send size={13} />
                {t("landing.mockup.app.sendFeedback", { count: 1 })}
              </span>
            </span>
          </motion.div>
        ) : null}
        {phase === "sent" ? (
          <motion.div
            key="sent"
            initial={FADE_OUT}
            animate={FADE_IN}
            exit={FADE_OUT}
            className={FLOATING}
          >
            <span
              className={`flex items-center gap-[8px] rounded-[14px] border border-mock-border-accent bg-mock-surface0 px-[12px] py-[8px] text-[13px] whitespace-nowrap text-mock-fg ${FLOATING_SHADOW}`}
            >
              <CircleCheck size={16} className="text-mock-accent-bright" />
              {t("landing.mockup.app.feedbackSent", { recipient: PROVIDERS[RECIPIENT].name })}
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {/* Both spots are measured from the middle of the button's bottom edge. */}
      <span className="absolute bottom-[16px] left-1/2">
        <Pointer
          scene="review"
          click={SEND_FEEDBACK_CLICK}
          from={POINTER_TO_SEND}
          className="-top-[14px] left-[18px]"
        />
        <Pointer
          scene="review"
          click={RECIPIENT_CLICK}
          from={POINTER_TO_RECIPIENT}
          className="-top-[87px] left-[24px]"
        />
      </span>
    </>
  );
}
