import { motion, type Variants } from "framer-motion";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { PaseoMark } from "~/components/paseo-brand";

export interface SourceMockupProps {
  /** Whether the section is visible or reduced motion is requested. */
  active: boolean;
  reduceMotion: boolean;
}

export const STEP_VARIANTS: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay, duration: 0.32, ease: "easeOut" },
  }),
};

type AvatarSize = "xs" | "sm" | "md";

const AVATAR_DIM: Record<AvatarSize, string> = {
  xs: "h-4 w-4",
  sm: "h-6 w-6",
  md: "h-8 w-8 sm:h-9 sm:w-9",
};

const AVATAR_PX: Record<AvatarSize, number> = {
  xs: 16,
  sm: 24,
  md: 36,
};

const BOT_ICON_DIM: Record<AvatarSize, string> = {
  xs: "h-2.5 w-2.5",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4 sm:h-5 sm:w-5",
};

type OpenChipVariant = "brand" | "slack" | "discord" | "subtle";

const OPEN_CHIP_STYLES: Record<OpenChipVariant, string> = {
  brand: "bg-[#20744A] text-white",
  slack: "bg-[#007A5A] text-white",
  discord: "bg-[#248046] text-white",
  subtle: "border border-brand-green/50 bg-brand-green/20 text-[#9FE0B0]",
};

export function MockupStep({
  delay,
  className,
  children,
}: {
  delay: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div variants={STEP_VARIANTS} custom={delay} className={className}>
      {children}
    </motion.div>
  );
}

/**
 * Animated root container for a single source mockup. Keeps outer dimensions locked to the stage
 * so switching tabs or stepping through animations never shifts page layout.
 */
export function MockupStageWindow({
  ariaLabel,
  active,
  reduceMotion,
  className = "",
  children,
}: {
  ariaLabel: string;
  active: boolean;
  reduceMotion: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      role="img"
      aria-label={ariaLabel}
      initial={reduceMotion ? "shown" : "hidden"}
      animate={reduceMotion || active ? "shown" : "hidden"}
      className={`@container flex h-full flex-col overflow-hidden rounded-xl border wrap-anywhere shadow-[0_24px_64px_-24px_rgba(0,0,0,0.75)] ${className}`}
    >
      {children}
    </motion.div>
  );
}

/** Mo's photo avatar used consistently across all source mockups. */
export function MoAvatar({
  size = "md",
  rounded = "rounded-[6px]",
  className = "",
}: {
  size?: AvatarSize;
  rounded?: string;
  className?: string;
}) {
  const px = AVATAR_PX[size];
  return (
    <img
      src="/9viSwGkz_400x400.jpg"
      alt=""
      width={px}
      height={px}
      loading="lazy"
      decoding="async"
      className={`shrink-0 object-cover ${AVATAR_DIM[size]} ${rounded} ${className}`}
    />
  );
}

/**
 * Paseo bot avatar using the canonical Paseo butterfly mark (`PaseoMark`).
 * Used consistently for `paseo-bot` across Slack, GitHub, Linear, Discord, Schedules, and Webhooks.
 */
export function PaseoBotAvatar({
  size = "md",
  rounded = "rounded-[6px]",
  className = "",
}: {
  size?: AvatarSize;
  rounded?: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center border border-white/14 bg-[#101615] ${AVATAR_DIM[size]} ${rounded} ${className}`}
    >
      <PaseoMark className={`${BOT_ICON_DIM[size]} text-white`} />
    </span>
  );
}

/** Consistent "Open in Paseo" action chip rendered inside source mockups. */
export function OpenInPaseoChip({ variant = "brand" }: { variant?: OpenChipVariant }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[11.5px] font-medium ${OPEN_CHIP_STYLES[variant]}`}
    >
      <PaseoMark className="h-3.5 w-3.5 shrink-0 text-current" />
      <span>{t("hub.demo.shared.openInPaseo")}</span>
    </span>
  );
}

/** macOS-style window traffic lights for desktop-style mockup headers. */
export function WindowTrafficLights() {
  return (
    <div className="flex items-center gap-1.5 @max-[14rem]:hidden" aria-hidden="true">
      <span className="h-2.5 w-2.5 rounded-full bg-[#FF5F57]/85" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#FEBC2E]/85" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#28C840]/85" />
    </div>
  );
}
