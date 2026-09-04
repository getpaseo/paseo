// The iPhone frame every mobile mockup sits inside. Authored at a fixed
// "design" size — iPhone 17 Pro points, 402 x 874 — and scaled to whatever
// width its column gives it. The scale is pure CSS (`tan(atan2(100cqw, …))`,
// the same trick the desktop hero uses), so the frame stays crisp at any width
// with no JS and a correct server-rendered first paint.

import type * as React from "react";

export const PHONE_W = 402;
export const PHONE_H = 874;

const FRAME_ASPECT = { aspectRatio: `${PHONE_W} / ${PHONE_H}` };
const SCREEN_SCALE = {
  width: PHONE_W,
  height: PHONE_H,
  transform: `scale(tan(atan2(100cqw, ${PHONE_W}px)))`,
};
type PhoneDepth = "front" | "left" | "right";

const SLAB_STYLE: Record<Exclude<PhoneDepth, "front">, React.CSSProperties> = {
  left: { transform: "translate3d(-5px, 0, -8px)" },
  right: { transform: "translate3d(5px, 0, -8px)" },
};
const CONTACT_SHADOW_STYLE: Record<PhoneDepth, React.CSSProperties> = {
  front: { transform: "translate3d(0, 4px, -12px)" },
  left: { transform: "translate3d(-2px, 3px, -12px)" },
  right: { transform: "translate3d(2px, 3px, -12px)" },
};
const GLASS_STYLE = {
  background:
    "linear-gradient(122deg, rgba(255,255,255,0.048) 0%, rgba(255,255,255,0.016) 25%, transparent 43%), radial-gradient(circle at 78% 10%, rgba(255,255,255,0.026), transparent 31%)",
};

/** iOS status bar: time, dynamic island, and the signal/wifi/battery cluster. */
function StatusBar({ time }: { time: string }) {
  return (
    <div className="relative flex h-[54px] shrink-0 items-end justify-between px-[34px] pb-[13px]">
      <span className="text-[17px] font-semibold tracking-tight text-mock-fg tabular-nums">
        {time}
      </span>
      {/* Dynamic island. */}
      <div className="absolute top-[11px] left-1/2 h-[37px] w-[126px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex items-center gap-[7px] text-mock-fg">
        <CellularIcon />
        <WifiIcon />
        <BatteryIcon />
      </span>
    </div>
  );
}

function CellularIcon() {
  return (
    <svg width={18} height={12} viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
      <rect x={0} y={8} width={3} height={4} rx={1} />
      <rect x={5} y={5.5} width={3} height={6.5} rx={1} />
      <rect x={10} y={3} width={3} height={9} rx={1} />
      <rect x={15} y={0.5} width={3} height={11.5} rx={1} />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg width={17} height={12} viewBox="0 0 17 12" fill="currentColor" aria-hidden="true">
      <path d="M8.5 2.1c2.7 0 5.2 1.05 7.05 2.77.3.29.31.77.02 1.07l-.72.73a.74.74 0 0 1-1.04.02A7.5 7.5 0 0 0 8.5 4.6a7.5 7.5 0 0 0-5.31 2.11.74.74 0 0 1-1.04-.02l-.72-.73a.76.76 0 0 1 .02-1.07A10.2 10.2 0 0 1 8.5 2.1Z" />
      <path d="M8.5 6.2c1.5 0 2.87.57 3.9 1.5.31.29.32.78.02 1.08l-.86.86a.73.73 0 0 1-1 .04 3.1 3.1 0 0 0-4.12 0 .73.73 0 0 1-1-.04l-.86-.86a.75.75 0 0 1 .02-1.08A5.83 5.83 0 0 1 8.5 6.2Z" />
      <path d="M8.5 9.9c.62 0 1.17.26 1.56.68.28.3.27.77-.02 1.06l-1 1a.76.76 0 0 1-1.08 0l-1-1a.75.75 0 0 1-.02-1.06c.39-.42.94-.68 1.56-.68Z" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg width={27} height={13} viewBox="0 0 27 13" fill="none" aria-hidden="true">
      <rect x={0.5} y={0.5} width={23} height={12} rx={3.6} stroke="currentColor" opacity={0.4} />
      <rect x={2} y={2} width={20} height={9} rx={2.2} fill="currentColor" />
      <rect x={25} y={4} width={1.6} height={5} rx={0.8} fill="currentColor" opacity={0.4} />
    </svg>
  );
}

function HomeIndicator() {
  return (
    <div className="pointer-events-none absolute bottom-[9px] left-1/2 h-[5px] w-[140px] -translate-x-1/2 rounded-full bg-mock-fg/30" />
  );
}

function FrontButtons() {
  return (
    <>
      <span className="pointer-events-none absolute top-[18%] -left-[2px] h-[8%] w-[3px] rounded-l-[2px] bg-[#1b1e1d]" />
      <span className="pointer-events-none absolute top-[28%] -left-[2px] h-[5%] w-[3px] rounded-l-[2px] bg-[#1b1e1d]" />
      <span className="pointer-events-none absolute top-[25%] -right-[2px] h-[13%] w-[3px] rounded-r-[2px] bg-[#151716]" />
    </>
  );
}

export function PhoneFrame({
  time,
  children,
  depth = "front",
}: {
  time: string;
  children: React.ReactNode;
  depth?: PhoneDepth;
}) {
  return (
    <div className="relative w-full select-none [transform-style:preserve-3d]" style={FRAME_ASPECT}>
      <div
        className="pointer-events-none absolute right-[8%] -bottom-[0.8%] left-[8%] h-[3.5%] rounded-full bg-black/25 blur-[10px]"
        style={CONTACT_SHADOW_STYLE[depth]}
      />

      {depth === "front" ? (
        <FrontButtons />
      ) : (
        <div
          className="pointer-events-none absolute inset-0 rounded-[13.5%/6.2%] border border-white/7 bg-[linear-gradient(180deg,#303432_0%,#1b1e1d_42%,#0b0d0c_100%)] shadow-[0_8px_22px_rgba(0,0,0,0.2)]"
          style={SLAB_STYLE[depth]}
        />
      )}

      <div className="absolute inset-0 overflow-hidden rounded-[13.5%/6.2%] border-[3px] border-black bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] outline outline-[1px] outline-white/25">
        <div className="absolute -inset-[3px] [container-type:inline-size]">
          <div className="absolute top-0 left-0 origin-top-left" style={SCREEN_SCALE}>
            <div className="relative flex h-[874px] w-[402px] flex-col overflow-hidden bg-mock-surface0 text-mock-fg antialiased">
              <StatusBar time={time} />
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                {children}
              </div>
              <HomeIndicator />
            </div>
          </div>
        </div>
        <div className="pointer-events-none absolute inset-0 z-20" style={GLASS_STYLE} />
      </div>
    </div>
  );
}
