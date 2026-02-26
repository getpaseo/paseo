"use client"

import { LucideProps } from "lucide-react"
import * as React from "react"

type IconProps = React.SVGProps<SVGSVGElement> & { className?: string }

export function AnthropicLogoIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 92.2 65"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <use
        href="/anthropic-logo.svg#Layer_1"
        xlinkHref="/anthropic-logo.svg#Layer_1"
      />
    </svg>
  )
}

export function IconGap(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M2.5 4.75C1.80964 4.75 1.25 4.19036 1.25 3.5V1H2.75V3.25H13.25V1H14.75V3.5C14.75 4.19036 14.1904 4.75 13.5 4.75H2.5ZM3 7.25H13V8.75H3V7.25ZM13.25 15V12.75H2.75V15H1.25V12.5C1.25 11.8096 1.80964 11.25 2.5 11.25H13.5C14.1904 11.25 14.75 11.8096 14.75 12.5V15H13.25Z" />
    </svg>
  )
}

export function IconDoubleChevronRight(props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      width="20"
      height="20"
      {...props}
    >
      <path d="m5.492 4.158 5.4 5.4a.625.625 0 0 1 0 .884l-5.4 5.4a.625.625 0 1 1-.884-.884L9.566 10 4.608 5.042a.625.625 0 1 1 .884-.884" />
      <path d="m16.392 10.442-5.4 5.4a.625.625 0 0 1-.884-.884L15.066 10l-4.958-4.958a.625.625 0 0 1 .884-.884l5.4 5.4a.625.625 0 0 1 0 .884" />
    </svg>
  )
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M14 6L20 12L14 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 12H4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconDoubleChevronLeft(props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      width="20"
      height="20"
      {...props}
      style={{ transform: "scaleX(-1)", ...props.style }}
    >
      <path d="m5.492 4.158 5.4 5.4a.625.625 0 0 1 0 .884l-5.4 5.4a.625.625 0 1 1-.884-.884L9.566 10 4.608 5.042a.625.625 0 1 1 .884-.884" />
      <path d="m16.392 10.442-5.4 5.4a.625.625 0 0 1-.884-.884L15.066 10l-4.958-4.958a.625.625 0 0 1 .884-.884l5.4 5.4a.625.625 0 0 1 0 .884" />
    </svg>
  )
}

/** @deprecated Use IconDoubleChevronRight instead */
export function IconCloseSidebarRight(props: IconProps) {
  return <IconDoubleChevronRight {...props} />
}

export function IconOpenSidebarRight(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="24" {...props}>
      <g transform="scale(1.05, 1.05) translate(-1.5, -1.15)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M9.35719 3H14.6428C15.7266 2.99999 16.6007 2.99998 17.3086 3.05782C18.0375 3.11737 18.6777 3.24318 19.27 3.54497C20.2108 4.02433 20.9757 4.78924 21.455 5.73005C21.7568 6.32234 21.8826 6.96253 21.9422 7.69138C22 8.39925 22 9.27339 22 10.3572V13.6428C22 14.7266 22 15.6008 21.9422 16.3086C21.8826 17.0375 21.7568 17.6777 21.455 18.27C20.9757 19.2108 20.2108 19.9757 19.27 20.455C18.6777 20.7568 18.0375 20.8826 17.3086 20.9422C16.6008 21 15.7266 21 14.6428 21H9.35717C8.27339 21 7.39925 21 6.69138 20.9422C5.96253 20.8826 5.32234 20.7568 4.73005 20.455C3.78924 19.9757 3.02433 19.2108 2.54497 18.27C2.24318 17.6777 2.11737 17.0375 2.05782 16.3086C1.99998 15.6007 1.99999 14.7266 2 13.6428V10.3572C1.99999 9.27341 1.99998 8.39926 2.05782 7.69138C2.11737 6.96253 2.24318 6.32234 2.54497 5.73005C3.02433 4.78924 3.78924 4.02433 4.73005 3.54497C5.32234 3.24318 5.96253 3.11737 6.69138 3.05782C7.39926 2.99998 8.27341 2.99999 9.35719 3ZM6.85424 5.05118C6.24907 5.10062 5.90138 5.19279 5.63803 5.32698C5.07354 5.6146 4.6146 6.07354 4.32698 6.63803C4.19279 6.90138 4.10062 7.24907 4.05118 7.85424C4.00078 8.47108 4 9.26339 4 10.4V13.6C4 14.7366 4.00078 15.5289 4.05118 16.1458C4.10062 16.7509 4.19279 17.0986 4.32698 17.362C4.6146 17.9265 5.07354 18.3854 5.63803 18.673C5.90138 18.8072 6.24907 18.8994 6.85424 18.9488C7.47108 18.9992 8.26339 19 9.4 19H14.6C15.7366 19 16.5289 18.9992 17.1458 18.9488C17.7509 18.8994 18.0986 18.8072 18.362 18.673C18.9265 18.3854 19.3854 17.9265 19.673 17.362C19.8072 17.0986 19.8994 16.7509 19.9488 16.1458C19.9992 15.5289 20 14.7366 20 13.6V10.4C20 9.26339 19.9992 8.47108 19.9488 7.85424C19.8994 7.24907 19.8072 6.90138 19.673 6.63803C19.3854 6.07354 18.9265 5.6146 18.362 5.32698C18.0986 5.19279 17.7509 5.10062 17.1458 5.05118C16.5289 5.00078 15.7366 5 14.6 5H9.4C8.26339 5 7.47108 5.00078 6.85424 5.05118ZM11 7C11.5523 7 12 7.44772 12 8V16C12 16.5523 11.5523 17 11 17C10.4477 17 10 16.5523 10 16V8C10 7.44772 10.4477 7 11 7Z"
          fill="currentColor"
        />
        <path
          d="M18 8C18 7.44772 17.5523 7 17 7C16.4477 7 16 7.44772 16 8V16C16 16.5523 16.4477 17 17 17C17.5523 17 18 16.5523 18 16V8Z"
          fill="currentColor"
        />
        <path d="M11 7H17V17H11V7Z" fill="currentColor" />
      </g>
    </svg>
  )
}

export function IconForcePush(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M5 14L12 7L19 14" />
      <path d="M5 10L12 3L19 10" />
      <path d="M12 21V7" />
    </svg>
  )
}

export function IconFetch(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path d="M19 4V8H15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.98828 20V16H8.98828" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 12C20 16.4183 16.4183 20 12 20C9.36378 20 6.96969 18.7249 5.5 16.7578" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12C4 7.58172 7.58172 4 12 4C14.6045 4 16.9726 5.24457 18.4465 7.17142" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function DiffIcon(props: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.1, -1.1)">
        <path d="M20 18V6C20 4.89543 19.1046 4 18 4H6C4.89543 4 4 4.89543 4 6V18C4 19.1046 4.89543 20 6 20H18C19.1046 20 20 19.1046 20 18Z" />
        <path d="M9.5 10H14.5M12 7.5V12.5" />
        <path d="M9.5 16L14.5 16" />
      </g>
    </svg>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="24" height="24" {...props}>
      <g transform="scale(1.05) translate(-1.1, -1.1)">
        <path
          d="M12 8V12L14.5 14.5M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function GitBranchFilledIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path d="M6.5 3C4.84315 3 3.5 4.34315 3.5 6C3.5 7.30622 4.33481 8.41746 5.5 8.82929V15.1707C4.33481 15.5825 3.5 16.6938 3.5 18C3.5 19.6569 4.84315 21 6.5 21C8.15685 21 9.5 19.6569 9.5 18C9.5 16.6938 8.66519 15.5825 7.5 15.1707V14C7.5 13.4477 7.94772 13 8.5 13H15.5C17.1569 13 18.5 11.6569 18.5 10V8.82929C19.6652 8.41746 20.5 7.30622 20.5 6C20.5 4.34315 19.1569 3 17.5 3C15.8431 3 14.5 4.34315 14.5 6C14.5 7.30622 15.3348 8.41746 16.5 8.82929V10C16.5 10.5523 16.0523 11 15.5 11H8.5C8.14936 11 7.81278 11.0602 7.5 11.1707V8.82929C8.66519 8.41746 9.5 7.30622 9.5 6C9.5 4.34315 8.15685 3 6.5 3Z" />
    </svg>
  )
}

export function FolderFilledIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path d="M5 3C3.34315 3 2 4.34315 2 6V17C2 18.6569 3.34315 20 5 20H19C20.6569 20 22 18.6569 22 17V9C22 7.34315 20.6569 6 19 6L12.5352 6L11.4258 4.3359C10.8694 3.5013 9.93269 3 8.92963 3H5Z" />
    </svg>
  )
}

export function GitPullRequestFilledIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path d="M6 3C4.34315 3 3 4.34315 3 6C3 7.30622 3.83481 8.41746 5 8.82929V15.1707C3.83481 15.5825 3 16.6938 3 18C3 19.6569 4.34315 21 6 21C7.65685 21 9 19.6569 9 18C9 16.6938 8.16519 15.5825 7 15.1707V8.82929C8.16519 8.41746 9 7.30622 9 6C9 4.34315 7.65685 3 6 3Z" />
      <path d="M14.4142 5L14.7071 4.70711C15.0976 4.31658 15.0976 3.68342 14.7071 3.29289C14.3166 2.90237 13.6834 2.90237 13.2929 3.29289L11.2929 5.29289C10.9024 5.68342 10.9024 6.31658 11.2929 6.70711L13.2929 8.70711C13.6834 9.09763 14.3166 9.09763 14.7071 8.70711C15.0976 8.31658 15.0976 7.68342 14.7071 7.29289L14.4142 7H16C16.5523 7 17 7.44772 17 8V15.1707C15.8348 15.5825 15 16.6938 15 18C15 19.6569 16.3431 21 18 21C19.6569 21 21 19.6569 21 18C21 16.6938 20.1652 15.5825 19 15.1707V8C19 6.34315 17.6569 5 16 5H14.4142Z" />
    </svg>
  )
}

export function IconChatBubble(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 10H9M12 14H9M3 20H16C18.7614 20 21 17.7614 21 15V9C21 6.23858 18.7614 4 16 4H8C5.23858 4 3 6.23858 3 9V20Z" />
    </svg>
  )
}

export function CopyCodeIcon(props: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7H8V5Z" />
      <path d="M16 5H18C19.1046 5 20 5.89543 20 7V11M8 5H6C4.89543 5 4 5.89543 4 7V19C4 20.1046 4.89543 21 6 21H12" />
      <path d="M16.0858 15L14.2929 16.7929C13.9024 17.1834 13.9024 17.8166 14.2929 18.2071L16.0858 20M20.0858 15L21.8787 16.7929C22.2692 17.1834 22.2692 17.8166 21.8787 18.2071L20.0858 20" />
    </svg>
  )
}

export function GitApplyIcon(props: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7H8V5Z" />
      <path d="M16 5H18C19.1046 5 20 5.89543 20 7V11M8 5H6C4.89543 5 4 5.89543 4 7V19C4 20.1046 4.89543 21 6 21H12" />
      <path d="M15 18H23M23 18L19.6246 15M23 18L19.6246 21" />
    </svg>
  )
}

export function CopyPatchIcon(props: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7H8V5Z" />
      <path d="M16 5H18C19.1046 5 20 5.89543 20 7V10M8 5H6C4.89543 5 4 5.89543 4 7V19C4 20.1046 4.89543 21 6 21H13.5" />
      <path d="M20 13V15.5M20 15.5V18M20 15.5H17.5M20 15.5H22.5" />
      <path d="M17.5 21C17.5 21 20.5474 21 22.5 21" />
    </svg>
  )
}

// Plan badges icons
export function PlanFreeIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12ZM8.29289 10.2929C7.90237 10.6834 7.90237 11.3166 8.29289 11.7071C8.68342 12.0976 9.31658 12.0976 9.70711 11.7071L11 10.4142V16C11 16.5523 11.4477 17 12 17C12.5523 17 13 16.5523 13 16V10.4142L14.2929 11.7071C14.6834 12.0976 15.3166 12.0976 15.7071 11.7071C16.0976 11.3166 16.0976 10.6834 15.7071 10.2929L12.7071 7.29289C12.3166 6.90237 11.6834 6.90237 11.2929 7.29289L8.29289 10.2929Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function PlanNearingIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.6026 4.07088C10.1677 1.5532 13.8318 1.5532 15.3969 4.07088L21.4996 13.8884C23.156 16.5529 21.2399 20.0001 18.1025 20.0001H5.89699C2.75962 20.0001 0.843525 16.5529 2.49985 13.8884L8.6026 4.07088ZM12 8C12.5523 8 13 8.44771 13 9V12C13 12.5523 12.5523 13 12 13C11.4477 13 11 12.5523 11 12V9C11 8.44771 11.4477 8 12 8ZM10.75 15C10.75 14.3096 11.3096 13.75 12 13.75C12.6904 13.75 13.25 14.3096 13.25 15C13.25 15.6904 12.6904 16.25 12 16.25C11.3096 16.25 10.75 15.6904 10.75 15Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function CaretRightIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M10 16L12.9393 13.0607C13.5251 12.4749 13.5251 11.5251 12.9393 10.9393L10 8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function IconTextAlignLeft(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M4.46967 9.09099L5 9.62132L6.06066 8.56066L5.53033 8.03033L3.56063 6.06063H10.125C11.989 6.06063 13.5 7.57167 13.5 9.43563C13.5 11.2996 11.989 12.8106 10.125 12.8106H4.5H3.75V14.3106H4.5H10.125C12.8174 14.3106 15 12.128 15 9.43563C15 6.74324 12.8174 4.56063 10.125 4.56063H3.56069L5.53033 2.59099L6.06066 2.06066L5 1L4.46967 1.53033L1.21967 4.78033C0.926777 5.07322 0.926777 5.5481 1.21967 5.84099L4.46967 9.09099Z" />
    </svg>
  )
}

export function IconTextAlignCenter(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M1.75 2H1V3.5H1.75H14.25H15V2H14.25H1.75ZM1 7H1.75H9.25H10V8.5H9.25H1.75H1V7ZM1 12H1.75H11.25H12V13.5H11.25H1.75H1V12Z" />
    </svg>
  )
}

export function IconTextAlignJustify(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M1.75 2H1V3.5H1.75H14.25H15V2H14.25H1.75ZM3.5 7.25H4.25H11.75H12.5V8.75H11.75H4.25H3.5V7.25ZM2.5 12.5H3.25H12.75H13.5V14H12.75H3.25H2.5V12.5Z" />
    </svg>
  )
}

export function IconTextAlignRight(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M1.75 2H1V3.5H1.75H14.25H15V2H14.25H1.75ZM6 7.25H6.75H14.25H15V8.75H14.25H6.75H6V7.25ZM4 12.5H4.75H14.25H15V14H14.25H4.75H4V12.5Z" />
    </svg>
  )
}

export function IconItalic(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M4.25 1H5H13.75H14.5V2.5H13.75H10.5475L7.02746 13.5H11H11.75V15H11H2.25H1.5V13.5H2.25H5.45254L8.97254 2.5H5H4.25V1Z" />
    </svg>
  )
}

export function IconUnderline(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M13.75 14.7504H2.25V13.2504H13.75V14.7504ZM5.25 8.00037C5.25009 8.8024 5.54638 9.4272 6.00977 9.85583C6.47885 10.2896 7.16404 10.5629 8 10.5629C8.83596 10.5629 9.52115 10.2896 9.99023 9.85583C10.4536 9.4272 10.7499 8.8024 10.75 8.00037V1.00037H12.25V8.00037C12.2499 9.19792 11.7961 10.2299 11.0098 10.9574C10.2289 11.6796 9.16375 12.0629 8 12.0629C6.83625 12.0629 5.77113 11.6796 4.99023 10.9574C4.20387 10.2299 3.75009 9.19792 3.75 8.00037V1.00037H5.25V8.00037Z" />
    </svg>
  )
}

export function IconStrikethrough(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M15 14.5H1V9.5H15V14.5ZM2.5 13H13.5V11H2.5V13ZM15 8.5H1V4.5H15V8.5ZM2.5 7H13.5V6H2.5V7ZM15 3.5H1V2H15V3.5Z" />
    </svg>
  )
}

export function IconUppercase(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M11.2002 9.25C11.2002 7.48269 9.76731 6.0498 8 6.0498C6.23269 6.0498 4.7998 7.48269 4.7998 9.25C4.7998 11.0173 6.23269 12.4502 8 12.4502V14.25C5.23858 14.25 3 12.0114 3 9.25C3 6.48858 5.23858 4.25 8 4.25C10.7614 4.25 13 6.48858 13 9.25C13 12.0114 10.7614 14.25 8 14.25V12.4502C9.76731 12.4502 11.2002 11.0173 11.2002 9.25Z" />
      <path d="M3 1.25H13V2.75H3V1.25Z" />
    </svg>
  )
}

export function IconDirectionRow(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M3.46975 11.7803L4.00008 12.3106L5.06074 11.25L4.53041 10.7196L2.56076 8.75H13.4393L11.4697 10.7197L10.9393 11.25L12 12.3107L12.5303 11.7803L15.6036 8.70711C15.9941 8.31658 15.9941 7.68342 15.6036 7.29289L12.5303 4.21967L12 3.68934L10.9393 4.75L11.4697 5.28033L13.4393 7.25H2.56072L4.53042 5.28031L5.06075 4.74998L4.00009 3.68932L3.46975 4.21965L0.396531 7.29287C0.00600663 7.68339 0.00600657 8.31656 0.396531 8.70708L3.46975 11.7803Z" />
    </svg>
  )
}

export function IconDirectionColumn(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M4.21968 3.46975L3.68935 4.00008L4.75001 5.06074L5.28034 4.53041L7.24999 2.56076L7.24999 13.4393L5.28031 11.4697L4.74998 10.9393L3.68932 12L4.21965 12.5303L7.29288 15.6036C7.6834 15.9941 8.31657 15.9941 8.70709 15.6036L11.7803 12.5303L12.3106 12L11.25 10.9393L10.7197 11.4697L8.74999 13.4393L8.74999 2.56072L10.7197 4.53041L11.25 5.06075L12.3107 4.00009L11.7803 3.46975L8.70712 0.396531C8.31659 0.00600645 7.68343 0.00600637 7.2929 0.396531L4.21968 3.46975Z" />
    </svg>
  )
}

export function IconMarginX(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14 1V15H12.5V1H14ZM5.00488 5.89746C5.05621 5.39333 5.48232 5 6 5H10L10.1025 5.00488C10.573 5.05278 10.9472 5.42703 10.9951 5.89746L11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6C5.48232 11 5.05621 10.6067 5.00488 10.1025L5 10V6L5.00488 5.89746ZM9.5 9.5V6.5H6.5L6.5 9.5H9.5ZM3.5 1L3.5 15H2L2 1H3.5Z" />
    </svg>
  )
}

export function IconMarginY(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M15 14H1V12.5H15V14ZM10.1025 5.00488C10.6067 5.05621 11 5.48232 11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6L5.89746 10.9951C5.42703 10.9472 5.05278 10.573 5.00488 10.1025L5 10V6C5 5.48232 5.39333 5.05621 5.89746 5.00488L6 5H10L10.1025 5.00488ZM6.5 9.5H9.5V6.5H6.5V9.5ZM15 3.5H1V2H15V3.5Z" />
    </svg>
  )
}

export function IconPaddingX(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.9951 14.1025C14.9438 14.6067 14.5177 15 14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2L1.00488 1.89746C1.05278 1.42703 1.42703 1.05278 1.89746 1.00488L2 1H14C14.5177 1 14.9438 1.39333 14.9951 1.89746L15 2V14L14.9951 14.1025ZM2.5 2.5V13.5H13.5V2.5H2.5ZM4.2666 12.375V3.625H5.66699V12.375H4.2666ZM10.333 12.375V3.625H11.7334V12.375H10.333Z" />
    </svg>
  )
}

export function IconPaddingY(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.1025 1.00488C14.6067 1.05621 15 1.48232 15 2V14L14.9951 14.1025C14.9472 14.573 14.573 14.9472 14.1025 14.9951L14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2C1 1.48232 1.39333 1.05621 1.89746 1.00488L2 1H14L14.1025 1.00488ZM2.5 13.5H13.5V2.5H2.5V13.5ZM12.375 11.7334H3.625V10.333H12.375V11.7334ZM12.375 5.66699H3.625V4.2666H12.375V5.66699Z" />
    </svg>
  )
}

export function IconExpand(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M1 5.25V6H2.5V5.25V2.5H5.25H6V1H5.25H2C1.44772 1 1 1.44772 1 2V5.25ZM5.25 14.9994H6V13.4994H5.25H2.5V10.7494V9.99939H1V10.7494V13.9994C1 14.5517 1.44772 14.9994 2 14.9994H5.25ZM15 10V10.75V14C15 14.5523 14.5523 15 14 15H10.75H10V13.5H10.75H13.5V10.75V10H15ZM10.75 1H10V2.5H10.75H13.5V5.25V6H15V5.25V2C15 1.44772 14.5523 1 14 1H10.75Z" />
    </svg>
  )
}

export function IconLock(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M10 4.5V6H6V4.5C6 3.39543 6.89543 2.5 8 2.5C9.10457 2.5 10 3.39543 10 4.5ZM4.5 6V4.5C4.5 2.567 6.067 1 8 1C9.933 1 11.5 2.567 11.5 4.5V6H12.5H14V7.5V12.5C14 13.8807 12.8807 15 11.5 15H4.5C3.11929 15 2 13.8807 2 12.5V7.5V6H3.5H4.5ZM11.5 7.5H10H6H4.5H3.5V12.5C3.5 13.0523 3.94772 13.5 4.5 13.5H11.5C12.0523 13.5 12.5 13.0523 12.5 12.5V7.5H11.5Z" />
    </svg>
  )
}

export function IconTextStrikethrough(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M8.00001 0.583374C6.15186 0.583374 4.89601 1.20742 4.10921 2.08165C3.34402 2.93186 3.08334 3.95168 3.08334 4.66671C3.08334 5.30246 3.25446 5.98764 3.73035 6.62516C3.82673 6.75427 3.934 6.8793 4.05254 7H1.75H1V8.5H1.75H14.25H15V7H14.25H7.01815L6.51769 6.8024C5.6688 6.46724 5.19511 6.07985 4.93239 5.72789C4.67477 5.38278 4.58334 5.0232 4.58334 4.66671C4.58334 4.27063 4.73934 3.62378 5.22415 3.0851C5.68734 2.57044 6.51483 2.08337 8.00001 2.08337C9.99003 2.08337 10.8295 2.95573 11.1785 3.6895L11.5006 4.36679L12.8552 3.72252L12.5331 3.04522C11.9243 1.76535 10.5425 0.583374 8.00001 0.583374ZM12.9167 11.25V10.5H11.4167V11.25C11.4167 11.6491 11.2587 12.3206 10.7686 12.8815C10.302 13.4155 9.47586 13.9167 8.00001 13.9167C6.13953 13.9167 5.27285 13.0402 4.87848 12.3L4.52584 11.638L3.20199 12.3433L3.55464 13.0053C4.18889 14.1958 5.54264 15.4167 8.00001 15.4167C9.85749 15.4167 11.1147 14.7652 11.8981 13.8685C12.658 12.9988 12.9167 11.9621 12.9167 11.25Z" />
    </svg>
  )
}

export function IconTextOverline(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M11.2002 9.25C11.2002 7.48269 9.76731 6.0498 8 6.0498C6.23269 6.0498 4.7998 7.48269 4.7998 9.25C4.7998 11.0173 6.23269 12.4502 8 12.4502V14.25C5.23858 14.25 3 12.0114 3 9.25C3 6.48858 5.23858 4.25 8 4.25C10.7614 4.25 13 6.48858 13 9.25C13 12.0114 10.7614 14.25 8 14.25V12.4502C9.76731 12.4502 11.2002 11.0173 11.2002 9.25Z" />
      <path d="M3 1.25H13V2.75H3V1.25Z" />
    </svg>
  )
}

export function IconTextStriked(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M8.00371 14.804C5.07771 14.804 3.23471 12.068 3.23471 7.774C3.23471 3.442 5.07771 0.706 8.00371 0.706C10.9297 0.706 12.7727 3.442 12.7727 7.774C12.7727 12.068 10.9297 14.804 8.00371 14.804ZM4.88771 7.774C4.88771 9.047 5.05871 10.149 5.40071 11.023L9.80871 3.1C9.31471 2.568 8.70671 2.264 8.00371 2.264C6.10371 2.264 4.88771 4.392 4.88771 7.774ZM6.17971 12.41C6.67371 12.942 7.30071 13.246 8.00371 13.246C9.90371 13.246 11.1197 11.118 11.1197 7.774C11.1197 6.463 10.9297 5.323 10.5877 4.43L6.17971 12.41Z" />
    </svg>
  )
}

export function IconTextJustifySpaced(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M1 2H1.75H14.25H15V3.5H14.25H1.75H1V2ZM1 12.5H1.75H14.25H15V14H14.25H1.75H1V12.5ZM1.75 7.25H1V8.75H1.75H14.25H15V7.25H14.25H1.75Z" />
    </svg>
  )
}

export function IconAlignStretch(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M1 1V15H2.5V1H1ZM11.9951 9.89746C11.9438 9.39333 11.5177 9 11 9H5C4.48232 9 4.05621 9.39333 4.00488 9.89746L4 10V13L4.00488 13.1025C4.05621 13.6067 4.48232 14 5 14H11C11.5177 14 11.9438 13.6067 11.9951 13.1025L12 13V10L11.9951 9.89746ZM11.9951 2.89746C11.9438 2.39333 11.5177 2 11 2H5C4.48232 2 4.05621 2.39333 4.00488 2.89746L4 3V6L4.00488 6.10254C4.05621 6.60667 4.48232 7 5 7L11 7C11.5177 7 11.9438 6.60667 11.9951 6.10254L12 6V3L11.9951 2.89746ZM5.5 12.5V10.5H10.5V12.5H5.5ZM5.5 5.5V3.5H10.5V5.5H5.5ZM13.5 1V15H15V1H13.5Z" />
    </svg>
  )
}

export function IconAlignStart(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M5.25488 2.89746C5.30621 2.39333 5.73232 2 6.25 2H13.25L13.3525 2.00488C13.823 2.05278 14.1972 2.42703 14.2451 2.89746L14.25 3V6L14.2451 6.10254C14.1972 6.57297 13.823 6.94722 13.3525 6.99512L13.25 7L6.25 7C5.73232 7 5.30621 6.60667 5.25488 6.10254L5.25 6L5.25 3L5.25488 2.89746ZM12.75 5.5V3.5H6.75V5.5H12.75ZM5.25488 9.89746C5.30621 9.39333 5.73232 9 6.25 9H9.25L9.35254 9.00488C9.82297 9.05278 10.1972 9.42703 10.2451 9.89746L10.25 10V13L10.2451 13.1025C10.1972 13.573 9.82297 13.9472 9.35254 13.9951L9.25 14H6.25C5.73232 14 5.30621 13.6067 5.25488 13.1025L5.25 13V10L5.25488 9.89746ZM8.75 12.5V10.5H6.75V12.5H8.75ZM3.75 1L3.75 15H2.25L2.25 1H3.75Z" />
    </svg>
  )
}

export function IconAlignCenter(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M2.50488 2.89746C2.55621 2.39333 2.98232 2 3.5 2H7.75V0H9.25V2H13.5L13.6025 2.00488C14.073 2.05278 14.4472 2.42703 14.4951 2.89746L14.5 3V6L14.4951 6.10254C14.4472 6.57297 14.073 6.94722 13.6025 6.99512L13.5 7H9.25V9H11.5C12.0177 9 12.4438 9.39333 12.4951 9.89746L12.5 10V13L12.4951 13.1025C12.4438 13.6067 12.0177 14 11.5 14H9.25V16H7.75V14H5.5C4.98232 14 4.55621 13.6067 4.50488 13.1025L4.5 13V10L4.50488 9.89746C4.55621 9.39333 4.98232 9 5.5 9H7.75L7.75 7H3.5C2.98232 7 2.55621 6.60667 2.50488 6.10254L2.5 6L2.5 3L2.50488 2.89746ZM13 5.5V3.5H4V5.5H13ZM11 12.5V10.5H6V12.5H11Z" />
    </svg>
  )
}

export function IconAlignEnd(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M11.7451 2.89746C11.6938 2.39333 11.2677 2 10.75 2H3.75L3.64746 2.00488C3.17703 2.05278 2.80278 2.42703 2.75488 2.89746L2.75 3V6L2.75488 6.10254C2.80278 6.57297 3.17703 6.94722 3.64746 6.99512L3.75 7L10.75 7C11.2677 7 11.6938 6.60667 11.7451 6.10254L11.75 6V3L11.7451 2.89746ZM4.25 5.5V3.5H10.25V5.5H4.25ZM11.7451 9.89746C11.6938 9.39333 11.2677 9 10.75 9H7.75L7.64746 9.00488C7.17703 9.05278 6.80278 9.42703 6.75488 9.89746L6.75 10V13L6.75488 13.1025C6.80278 13.573 7.17703 13.9472 7.64746 13.9951L7.75 14H10.75C11.2677 14 11.6938 13.6067 11.7451 13.1025L11.75 13V10L11.7451 9.89746ZM8.25 12.5V10.5H10.25V12.5H8.25ZM13.25 1V15H14.75V1H13.25Z" />
    </svg>
  )
}

export function UnarchiveIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.1 -1.1)">
        <path d="M18 20C19.1046 20 20 19.1046 20 18V7H4V18C4 19.1046 4.89543 20 6 20H18Z" />
        <path d="M20 7L15 3M4 7L9 3" />
        <path d="M10 11H14" />
      </g>
    </svg>
  )
}

// Text alignment icons (5 options)
export function IconTextUndo(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.46967 9.09099L5 9.62132L6.06066 8.56066L5.53033 8.03033L3.56063 6.06063H10.125C11.989 6.06063 13.5 7.57167 13.5 9.43563C13.5 11.2996 11.989 12.8106 10.125 12.8106H4.5H3.75V14.3106H4.5H10.125C12.8174 14.3106 15 12.128 15 9.43563C15 6.74324 12.8174 4.56063 10.125 4.56063H3.56069L5.53033 2.59099L6.06066 2.06066L5 1L4.46967 1.53033L1.21967 4.78033C0.926777 5.07322 0.926777 5.5481 1.21967 5.84099L4.46967 9.09099Z"
      />
    </svg>
  )
}

export function IconTextAlignLeftNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1.75 2H1V3.5H1.75H14.25H15V2H14.25H1.75ZM1 7H1.75H9.25H10V8.5H9.25H1.75H1V7ZM1 12H1.75H11.25H12V13.5H11.25H1.75H1V12Z"
      />
    </svg>
  )
}

export function IconTextAlignCenterNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1.75 2H1V3.5H1.75H14.25H15V2H14.25H1.75ZM3.5 7.25H4.25H11.75H12.5V8.75H11.75H4.25H3.5V7.25ZM2.5 12.5H3.25H12.75H13.5V14H12.75H3.25H2.5V12.5Z"
      />
    </svg>
  )
}

export function IconTextAlignRightNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1.75 2H1V3.5H1.75H14.25H15V2H14.25H1.75ZM6 7.25H6.75H14.25H15V8.75H14.25H6.75H6V7.25ZM4 12.5H4.75H14.25H15V14H14.25H4.75H4V12.5Z"
      />
    </svg>
  )
}

export function IconTextJustifyNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1 2H1.75H14.25H15V3.5H14.25H1.75H1V2ZM1 12.5H1.75H14.25H15V14H14.25H1.75H1V12.5ZM1.75 7.25H1V8.75H1.75H14.25H15V7.25H14.25H1.75Z"
      />
    </svg>
  )
}

// Decoration icons (5 options)
export function IconItalicNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.25 1H5H13.75H14.5V2.5H13.75H10.5475L7.02746 13.5H11H11.75V15H11H2.25H1.5V13.5H2.25H5.45254L8.97254 2.5H5H4.25V1Z"
      />
    </svg>
  )
}

export function IconStrikethroughNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.00001 0.583374C6.15186 0.583374 4.89601 1.20742 4.10921 2.08165C3.34402 2.93186 3.08334 3.95168 3.08334 4.66671C3.08334 5.30246 3.25446 5.98764 3.73035 6.62516C3.82673 6.75427 3.934 6.8793 4.05254 7H1.75H1V8.5H1.75H14.25H15V7H14.25H7.01815L6.51769 6.8024C5.6688 6.46724 5.19511 6.07985 4.93239 5.72789C4.67477 5.38278 4.58334 5.0232 4.58334 4.66671C4.58334 4.27063 4.73934 3.62378 5.22415 3.0851C5.68734 2.57044 6.51483 2.08337 8.00001 2.08337C9.99003 2.08337 10.8295 2.95573 11.1785 3.6895L11.5006 4.36679L12.8552 3.72252L12.5331 3.04522C11.9243 1.76535 10.5425 0.583374 8.00001 0.583374ZM12.9167 11.25V10.5H11.4167V11.25C11.4167 11.6491 11.2587 12.3206 10.7686 12.8815C10.302 13.4155 9.47586 13.9167 8.00001 13.9167C6.13953 13.9167 5.27285 13.0402 4.87848 12.3L4.52584 11.638L3.20199 12.3433L3.55464 13.0053C4.18889 14.1958 5.54264 15.4167 8.00001 15.4167C9.85749 15.4167 11.1147 14.7652 11.8981 13.8685C12.658 12.9988 12.9167 11.9621 12.9167 11.25Z"
      />
    </svg>
  )
}

export function IconUnderlineNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M13.75 14.7504H2.25V13.2504H13.75V14.7504ZM5.25 8.00037C5.25009 8.8024 5.54638 9.4272 6.00977 9.85583C6.47885 10.2896 7.16404 10.5629 8 10.5629C8.83596 10.5629 9.52115 10.2896 9.99023 9.85583C10.4536 9.4272 10.7499 8.8024 10.75 8.00037V1.00037H12.25V8.00037C12.2499 9.19792 11.7961 10.2299 11.0098 10.9574C10.2289 11.6796 9.16375 12.0629 8 12.0629C6.83625 12.0629 5.77113 11.6796 4.99023 10.9574C4.20387 10.2299 3.75009 9.19792 3.75 8.00037V1.00037H5.25V8.00037Z" />
    </svg>
  )
}

export function IconOverlineNew(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M11.2002 9.25C11.2002 7.48269 9.76731 6.0498 8 6.0498C6.23269 6.0498 4.7998 7.48269 4.7998 9.25C4.7998 11.0173 6.23269 12.4502 8 12.4502V14.25C5.23858 14.25 3 12.0114 3 9.25C3 6.48858 5.23858 4.25 8 4.25C10.7614 4.25 13 6.48858 13 9.25C13 12.0114 10.7614 14.25 8 14.25V12.4502C9.76731 12.4502 11.2002 11.0173 11.2002 9.25Z" />
      <path d="M3 1.25H13V2.75H3V1.25Z" />
    </svg>
  )
}

export function IconTextNone(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M8.00371 14.804C5.07771 14.804 3.23471 12.068 3.23471 7.774C3.23471 3.442 5.07771 0.706 8.00371 0.706C10.9297 0.706 12.7727 3.442 12.7727 7.774C12.7727 12.068 10.9297 14.804 8.00371 14.804ZM4.88771 7.774C4.88771 9.047 5.05871 10.149 5.40071 11.023L9.80871 3.1C9.31471 2.568 8.70671 2.264 8.00371 2.264C6.10371 2.264 4.88771 4.392 4.88771 7.774ZM6.17971 12.41C6.67371 12.942 7.30071 13.246 8.00371 13.246C9.90371 13.246 11.1197 11.118 11.1197 7.774C11.1197 6.463 10.9297 5.323 10.5877 4.43L6.17971 12.41Z" />
    </svg>
  )
}

export function IconColorDefault(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...props}>
      <g clipPath="url(#clip0_11223_26136)">
        <rect
          x="0.75"
          y="0.75"
          width="14.5"
          height="14.5"
          rx="3.25"
          stroke="currentColor"
          strokeWidth="1.5"
        ></rect>
        <path
          opacity="0.33"
          d="M3 15L1.5 14.5L1 13H3V15ZM7 15H5V13H7V15ZM11 15H9V13H11V15ZM14.5 14.5L13 15V13H15L14.5 14.5ZM5 13H3V11H5V13ZM9 13H7V11H9V13ZM13 13H11V11H13V13ZM3 11H1V9H3V11ZM7 11H5V9H7V11ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM5 9H3V7H5V9ZM9 9H7V7H9V9ZM13 9H11V7H13V9ZM3 7H1V5H3V7ZM7 7H5V5H7V7ZM11 7H9V5H11V7ZM15 7H13V5H15V7ZM5 5H3V3H5V5ZM9 5H7V3H9V5ZM13 5H11V3H13V5ZM3 3H1L1.5 1.5L3 1V3ZM7 3H5V1H7V3ZM11 3H9V1H11V3ZM14.5 1.5L15 3H13V1L14.5 1.5Z"
          fill="currentColor"
        ></path>
      </g>
      <defs>
        <clipPath id="clip0_11223_26136">
          <rect width="16" height="16" fill="white"></rect>
        </clipPath>
      </defs>
    </svg>
  )
}

export function IconBorderWidth(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M15 14.5H1V9.5H15V14.5ZM2.5 13H13.5V11H2.5V13ZM15 8.5H1V4.5H15V8.5ZM2.5 7H13.5V6H2.5V7ZM15 3.5H1V2H15V3.5Z" />
    </svg>
  )
}

export function IconExpandBorder(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1 5.25V6H2.5V5.25V2.5H5.25H6V1H5.25H2C1.44772 1 1 1.44772 1 2V5.25ZM5.25 14.9994H6V13.4994H5.25H2.5V10.7494V9.99939H1V10.7494V13.9994C1 14.5517 1.44772 14.9994 2 14.9994H5.25ZM15 10V10.75V14C15 14.5523 14.5523 15 14 15H10.75H10V13.5H10.75H13.5V10.75V10H15ZM10.75 1H10V2.5H10.75H13.5V5.25V6H15V5.25V2C15 1.44772 14.5523 1 14 1H10.75Z"
      />
    </svg>
  )
}

// Margin icons for individual sides
export function IconMarginTop(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M10.1025 5.00488C10.6067 5.05621 11 5.48232 11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6L5.89746 10.9951C5.42703 10.9472 5.05278 10.573 5.00488 10.1025L5 10V6C5 5.48232 5.39333 5.05621 5.89746 5.00488L6 5H10L10.1025 5.00488ZM6.5 9.5H9.5V6.5H6.5V9.5ZM15 3.5H1V2H15V3.5Z" />
    </svg>
  )
}

export function IconMarginBottom(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M15 14H1V12.5H15V14ZM10.1025 5.00488C10.6067 5.05621 11 5.48232 11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6L5.89746 10.9951C5.42703 10.9472 5.05278 10.573 5.00488 10.1025L5 10V6C5 5.48232 5.39333 5.05621 5.89746 5.00488L6 5H10L10.1025 5.00488ZM6.5 9.5H9.5V6.5H6.5V9.5Z" />
    </svg>
  )
}

export function IconMarginLeft(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M5.00488 5.89746C5.05621 5.39333 5.48232 5 6 5H10L10.1025 5.00488C10.573 5.05278 10.9472 5.42703 10.9951 5.89746L11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6C5.48232 11 5.05621 10.6067 5.00488 10.1025L5 10V6L5.00488 5.89746ZM9.5 9.5V6.5H6.5L6.5 9.5H9.5ZM3.5 1L3.5 15H2L2 1H3.5Z" />
    </svg>
  )
}

export function IconMarginRight(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14 1V15H12.5V1H14ZM5.00488 5.89746C5.05621 5.39333 5.48232 5 6 5H10L10.1025 5.00488C10.573 5.05278 10.9472 5.42703 10.9951 5.89746L11 6V10L10.9951 10.1025C10.9472 10.573 10.573 10.9472 10.1025 10.9951L10 11H6C5.48232 11 5.05621 10.6067 5.00488 10.1025L5 10L5 6L5.00488 5.89746ZM9.5 9.5V6.5H6.5V9.5H9.5Z" />
    </svg>
  )
}

// Spacing X/Y icons for grouped controls
export function IconSpacingX(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.9951 14.1025C14.9438 14.6067 14.5177 15 14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2L1.00488 1.89746C1.05278 1.42703 1.42703 1.05278 1.89746 1.00488L2 1H14C14.5177 1 14.9438 1.39333 14.9951 1.89746L15 2V14L14.9951 14.1025ZM2.5 2.5V13.5H13.5V2.5H2.5ZM4.2666 12.375V3.625H5.66699V12.375H4.2666ZM10.333 12.375V3.625H11.7334V12.375H10.333Z" />
    </svg>
  )
}

export function IconSpacingY(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.1025 1.00488C14.6067 1.05621 15 1.48232 15 2V14L14.9951 14.1025C14.9472 14.573 14.573 14.9472 14.1025 14.9951L14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2C1 1.48232 1.39333 1.05621 1.89746 1.00488L2 1H14L14.1025 1.00488ZM2.5 13.5H13.5V2.5H2.5V13.5ZM12.375 11.7334H3.625V10.333H12.375V11.7334ZM12.375 5.66699H3.625V4.2666H12.375V5.66699Z" />
    </svg>
  )
}

// Padding icons for individual sides
export function IconPaddingTop(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.1025 1.00488C14.6067 1.05621 15 1.48232 15 2V14L14.9951 14.1025C14.9472 14.573 14.573 14.9472 14.1025 14.9951L14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2C1 1.48232 1.39333 1.05621 1.89746 1.00488L2 1H14L14.1025 1.00488ZM2.5 13.5H13.5V2.5H2.5V13.5ZM12.375 5.66699H3.625V4.2666H12.375V5.66699Z" />
    </svg>
  )
}

export function IconPaddingBottom(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.1025 1.00488C14.6067 1.05621 15 1.48232 15 2V14L14.9951 14.1025C14.9472 14.573 14.573 14.9472 14.1025 14.9951L14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2C1 1.48232 1.39333 1.05621 1.89746 1.00488L2 1H14L14.1025 1.00488ZM2.5 13.5H13.5V2.5H2.5V13.5ZM12.375 11.7334H3.625V10.333H12.375V11.7334Z" />
    </svg>
  )
}

export function IconPaddingLeft(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.9951 14.1025C14.9438 14.6067 14.5177 15 14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2L1.00488 1.89746C1.05278 1.42703 1.42703 1.05278 1.89746 1.00488L2 1H14C14.5177 1 14.9438 1.39333 14.9951 1.89746L15 2V14L14.9951 14.1025ZM2.5 2.5V13.5H13.5V2.5H2.5ZM4.2666 12.375V3.625H5.66699V12.375H4.2666Z" />
    </svg>
  )
}

export function IconPaddingRight(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M14.9951 14.1025C14.9438 14.6067 14.5177 15 14 15H2L1.89746 14.9951C1.42703 14.9472 1.05278 14.573 1.00488 14.1025L1 14V2L1.00488 1.89746C1.05278 1.42703 1.42703 1.05278 1.89746 1.00488L2 1H14C14.5177 1 14.9438 1.39333 14.9951 1.89746L15 2V14L14.9951 14.1025ZM2.5 2.5V13.5H13.5V2.5H2.5ZM10.333 12.375V3.625H11.7334V12.375H10.333Z" />
    </svg>
  )
}

export function IconExpandAll(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6 1V1.75V5C6 5.55229 5.55228 6 5 6H1.75H1V4.5H1.75H4.5V1.75V1H6ZM14.25 6H15V4.5H14.25H11.5V1.75V1H10V1.75V5C10 5.55228 10.4477 6 11 6H14.25ZM10 14.25V15H11.5V14.25V11.5H14.29H15.04V10H14.29H11C10.4477 10 10 10.4477 10 11V14.25ZM1.75 10H1V11.5H1.75H4.5V14.25V15H6V14.25V11C6 10.4477 5.55229 10 5 10H1.75Z"
      />
    </svg>
  )
}

// Border width icons for individual sides
export function IconBorderWidthTop(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M3.60938 13.25H4.00977V14.75H2.10938V13H3.60938V13.25ZM7.46094 14.75H5.16016V13.25H7.46094V14.75ZM10.9121 14.75H8.61133V13.25H10.9121V14.75ZM13.9619 14.75H12.0615V13.25H12.4619V13H13.9619V14.75ZM3.60938 12H2.10938V10H3.60938V12ZM13.9629 12H12.4629V10H13.9629V12ZM3.60938 9H2.10938V7H3.60938V9ZM13.9629 9H12.4629V7H13.9629V9ZM15 6H1V2H15V6ZM2.5 4.5H13.5V3.5H2.5V4.5Z" />
    </svg>
  )
}

export function IconBorderWidthBottom(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M3.60938 3.5H4.00977V2H2.10938V3.75H3.60938V3.5ZM7.46094 2H5.16016V3.5H7.46094V2ZM10.9121 2H8.61133V3.5H10.9121V2ZM13.9619 2H12.0615V3.5H12.4619V3.75H13.9619V2ZM3.60938 4.75H2.10938V6.75H3.60938V4.75ZM13.9629 4.75H12.4629V6.75H13.9629V4.75ZM3.60938 7.75H2.10938V9.75H3.60938V7.75ZM13.9629 7.75H12.4629V9.75H13.9629V7.75ZM15 10.75H1V14.75H15V10.75ZM2.5 12.25H13.5V13.25H2.5V12.25Z" />
    </svg>
  )
}

export function IconBorderWidthLeft(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M13.25 3.60937V4.00977H14.75V2.10937H13V3.60937H13.25ZM14.75 7.46094V5.16016H13.25V7.46094H14.75ZM14.75 10.9121V8.61133H13.25V10.9121L14.75 10.9121ZM14.75 13.9619L14.75 12.0615L13.25 12.0615V12.4619H13L13 13.9619L14.75 13.9619ZM12 3.60937V2.10937L10 2.10937V3.60937L12 3.60937ZM12 13.9629L12 12.4629H10L10 13.9629H12ZM9 3.60937V2.10937L7 2.10937L7 3.60937L9 3.60937ZM9 13.9629V12.4629H7V13.9629H9ZM6 15L6 1L2 1L2 15H6ZM4.5 2.5L4.5 13.5H3.5L3.5 2.5H4.5Z" />
    </svg>
  )
}

export function IconBorderWidthRight(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path d="M3.5 3.60937V4.00977H2V2.10937H3.75V3.60937H3.5ZM2 7.46094V5.16016H3.5V7.46094H2ZM2 10.9121V8.61133H3.5V10.9121L2 10.9121ZM2 13.9619L2 12.0615L3.5 12.0615V12.4619H3.75L3.75 13.9619L2 13.9619ZM4.75 3.60937V2.10937L6.75 2.10937V3.60937L4.75 3.60937ZM4.75 13.9629L4.75 12.4629H6.75L6.75 13.9629H4.75ZM7.75 3.60937L7.75 2.10937L9.75 2.10937V3.60937L7.75 3.60937ZM7.75 13.9629V12.4629H9.75V13.9629H7.75ZM10.75 15L10.75 1L14.75 1L14.75 15H10.75ZM12.25 2.5L12.25 13.5H13.25L13.25 2.5H12.25Z" />
    </svg>
  )
}

export function IconOpacity(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <circle
        cx="8"
        cy="8"
        r="7.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="transparent"
      ></circle>
      <path
        opacity="0.33"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5 1H7V3H5V1ZM5 5V3H3V5H1V7H3V9H1V11H3V13H5V15H7V13H9V15H11V13H13V11H15V9H13V7H15V5H13V3H11V1H9V3H7V5H5ZM5 7H3V5H5V7ZM7 7V5H9V7H7ZM7 9V7H5V9H3V11H5V13H7V11H9V13H11V11H13V9H11V7H13V5H11V3H9V5H11V7H9V9H7ZM9 9H11V11H9V9ZM7 9V11H5V9H7Z"
        fill="currentColor"
      ></path>
    </svg>
  )
}

export function IconBorderRadius(props: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      {...props}
    >
      <path
        d="M13.9658 3.25024H7.72168C5.82405 3.25024 4.28522 4.78817 4.28516 6.68579V14.5002H2.78516V6.68579C2.78522 3.95975 4.99562 1.75024 7.72168 1.75024H13.9658V3.25024Z"
        fill="currentColor"
      ></path>
    </svg>
  )
}

export function IconShadow(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...props}>
      <g clipPath="url(#clip0_shadow)">
        <path
          opacity="0.33"
          d="M15.25 12C15.25 13.7949 13.7949 15.25 12 15.25H4C2.20508 15.25 0.750002 13.7949 0.75 12V11.9492C1.63982 13.0724 3.00385 13.7499 4.47168 13.75H11.2832C12.8846 13.7499 14.3732 12.9417 15.25 11.6074V12Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect
          x="0.75"
          y="0.75"
          width="14.5"
          height="11.5"
          rx="3.25"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </g>
      <defs>
        <clipPath id="clip0_shadow">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  )
}

export function IconShare(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.8, -1.8)">
        <path
          d="M20 14.75V17C20 18.6569 18.6569 20 17 20H7C5.34315 20 4 18.6569 4 17V14.75"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16.5 8.5L12 4L7.5 8.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 5V15.25"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function IconDownload(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.8, -1.8)">
        <path
          d="M20 15V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V15M12 14.5V4M12 14.5L8.5 11M12 14.5L15.5 11"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M6 9.5L12 15.5L18 9.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function IconChevronUp(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M6 14.5L12 8.5L18 14.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function IconSpinner(props: IconProps & { color?: string; size?: "default" | "nano" }) {
  const { className, style, color, size = "default", ...rest } = props
  const strokeWidth = size === "nano" ? 4 : 3
  return (
    <>
      <style>{`
        @keyframes icon-spinner-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        className={className}
        style={{
          animation: "icon-spinner-rotate 1s linear infinite",
          // GPU acceleration to keep spinning even when main thread is busy
          willChange: "transform",
          transform: "translateZ(0)",
          ...style,
        }}
        {...rest}
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke={color || "currentColor"}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          opacity={0.2}
        />
        <path
          d="M12 2C6.48 2 2 6.48 2 12"
          stroke={color || "currentColor"}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </>
  )
}

// Loading indicator that transitions from spinner to dot
// Shows spinner when loading, animates to blue dot when done
export function LoadingDot({
  isLoading,
  className,
  dotClassName = "bg-[#307BD0]"
}: {
  isLoading: boolean
  className?: string
  dotClassName?: string
}) {
  return (
    <div className={`relative ${className || ""}`}>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      {/* Spinner - visible when loading */}
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute inset-0 w-full h-full transition-[opacity,transform] duration-200 ease-out ${
          isLoading ? "opacity-100 scale-100" : "opacity-0 scale-50"
        }`}
        style={{
          animation: isLoading ? 'spin 1s linear infinite' : undefined,
        }}
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          opacity={0.2}
        />
        <path
          d="M12 2C6.48 2 2 6.48 2 12"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
      {/* Dot - appears when not loading */}
      <div
        className={`absolute inset-0 m-auto w-[80%] h-[80%] rounded-full transition-[opacity,transform] duration-200 ease-out ${dotClassName} ${
          isLoading ? "opacity-0 scale-50" : "opacity-100 scale-100"
        }`}
      />
    </div>
  )
}

export function IconEditFile(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...props}>
      <path
        d="M6.67 14.33H5.33C4.22 14.33 3.33 13.44 3.33 12.33V4C3.33 2.89 4.22 2 5.33 2H10.67C11.78 2 12.67 2.89 12.67 4V7.33"
        stroke="currentColor"
        strokeWidth="1.33"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.33 14V12.44L11.67 10.11C12.06 9.72 12.79 9.72 13.22 10.11C13.65 10.54 13.65 11.24 13.22 11.67L10.89 14H9.33Z"
        stroke="currentColor"
        strokeWidth="1.33"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <path
        d="M6 4.67H10"
        stroke="currentColor"
        strokeWidth="1.33"
        strokeLinecap="round"
      />
      <path
        d="M6 7.33H7.33"
        stroke="currentColor"
        strokeWidth="1.33"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function IconMoon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...props}>
      <g transform="scale(1.05)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8.06207 1.68681C8.19154 1.90981 8.18081 2.18749 8.03446 2.39981C7.59054 3.04388 7.33074 3.82385 7.33074 4.66651C7.33074 6.87566 9.12159 8.66651 11.3307 8.66651C12.1734 8.66651 12.9535 8.40668 13.5975 7.96274C13.8099 7.81641 14.0875 7.80559 14.3105 7.93506C14.5336 8.06454 14.6619 8.31093 14.6401 8.56793C14.3509 11.9830 11.4883 14.6640 7.99874 14.6640C4.31755 14.6640 1.33333 11.6798 1.33333 7.99861C1.33333 4.50915 4.01427 1.64657 7.42919 1.35721C7.68619 1.33543 7.93259 1.46379 8.06207 1.68681ZM6.28002 2.94944C4.17867 3.66452 2.66667 5.65523 2.66667 7.99861C2.66667 10.9434 5.05421 13.3307 7.99874 13.3307C10.3422 13.3307 12.3329 11.8186 13.0479 9.71713C12.5088 9.90041 11.9311 9.99984 11.3307 9.99984C8.38516 9.99984 5.99741 7.61209 5.99741 4.66651C5.99741 4.06621 6.09679 3.48853 6.28002 2.94944Z"
          fill="currentColor"
        />
        <path
          d="M10.8249 3.34491L11.3660 2.26279C11.4888 2.01711 11.8394 2.01711 11.9623 2.26279L12.5033 3.34491C12.5356 3.40942 12.5879 3.46173 12.6524 3.49398L13.7346 4.03503C13.9802 4.15788 13.9802 4.50848 13.7346 4.63132L12.6524 5.17237C12.5879 5.20461 12.5356 5.25692 12.5033 5.32143L11.9623 6.40356C11.8394 6.64924 11.4888 6.64924 11.3660 6.40356L10.8249 5.32143C10.7927 5.25692 10.7404 5.20461 10.6759 5.17237L9.59375 4.63132C9.34807 4.50848 9.34807 4.15788 9.59375 4.03503L10.6759 3.49398C10.7404 3.46173 10.7927 3.40942 10.8249 3.34491Z"
          fill="currentColor"
        />
      </g>
    </svg>
  )
}

export function IconSun(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...props}>
      <g transform="scale(1.15) translate(-1, -1)">
        <circle
          cx="8"
          cy="8"
          r="3.33"
          stroke="currentColor"
          strokeWidth="1.33"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M8 1.33V2.67M8 13.33V14.67M14.67 8H13.33M2.67 8H1.33M12.72 3.28L11.78 4.22M4.22 11.78L3.28 12.72M12.72 12.72L11.78 11.78M4.22 4.22L3.28 3.28"
          stroke="currentColor"
          strokeWidth="1.33"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function IconCloseSidebar(props: IconProps) {
  const { className, ...rest } = props
  return (
    <svg
      width="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      {...rest}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.35719 3H14.6428C15.7266 2.99999 16.6007 2.99998 17.3086 3.05782C18.0375 3.11737 18.6777 3.24318 19.27 3.54497C20.2108 4.02433 20.9757 4.78924 21.455 5.73005C21.7568 6.32234 21.8826 6.96253 21.9422 7.69138C22 8.39925 22 9.27339 22 10.3572V13.6428C22 14.7266 22 15.6008 21.9422 16.3086C21.8826 17.0375 21.7568 17.6777 21.455 18.27C20.9757 19.2108 20.2108 19.9757 19.27 20.455C18.6777 20.7568 18.0375 20.8826 17.3086 20.9422C16.6008 21 15.7266 21 14.6428 21H9.35717C8.27339 21 7.39925 21 6.69138 20.9422C5.96253 20.8826 5.32234 20.7568 4.73005 20.455C3.78924 19.9757 3.02433 19.2108 2.54497 18.27C2.24318 17.6777 2.11737 17.0375 2.05782 16.3086C1.99998 15.6007 1.99999 14.7266 2 13.6428V10.3572C1.99999 9.27341 1.99998 8.39926 2.05782 7.69138C2.11737 6.96253 2.24318 6.32234 2.54497 5.73005C3.02433 4.78924 3.78924 4.02433 4.73005 3.54497C5.32234 3.24318 5.96253 3.11737 6.69138 3.05782C7.39926 2.99998 8.27341 2.99999 9.35719 3ZM6.85424 5.05118C6.24907 5.10062 5.90138 5.19279 5.63803 5.32698C5.07354 5.6146 4.6146 6.07354 4.32698 6.63803C4.19279 6.90138 4.10062 7.24907 4.05118 7.85424C4.00078 8.47108 4 9.26339 4 10.4V13.6C4 14.7366 4.00078 15.5289 4.05118 16.1458C4.10062 16.7509 4.19279 17.0986 4.32698 17.362C4.6146 17.9265 5.07354 18.3854 5.63803 18.673C5.90138 18.8072 6.24907 18.8994 6.85424 18.9488C7.47108 18.9992 8.26339 19 9.4 19H14.6C15.7366 19 16.5289 18.9992 17.1458 18.9488C17.7509 18.8994 18.0986 18.8072 18.362 18.673C18.9265 18.3854 19.3854 17.9265 19.673 17.362C19.8072 17.0986 19.8994 16.7509 19.9488 16.1458C19.9992 15.5289 20 14.7366 20 13.6V10.4C20 9.26339 19.9992 8.47108 19.9488 7.85424C19.8994 7.24907 19.8072 6.90138 19.673 6.63803C19.3854 6.07354 18.9265 5.6146 18.362 5.32698C18.0986 5.19279 17.7509 5.10062 17.1458 5.05118C16.5289 5.00078 15.7366 5 14.6 5H9.4C8.26339 5 7.47108 5.00078 6.85424 5.05118ZM7 7C7.55229 7 8 7.44772 8 8V16C8 16.5523 7.55229 17 7 17C6.44772 17 6 16.5523 6 16V8C6 7.44772 6.44772 7 7 7Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function IconOpenSidebar(props: IconProps) {
  return (
    <svg
      width="18"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.35719 3H14.6428C15.7266 2.99999 16.6007 2.99998 17.3086 3.05782C18.0375 3.11737 18.6777 3.24318 19.27 3.54497C20.2108 4.02433 20.9757 4.78924 21.455 5.73005C21.7568 6.32234 21.8826 6.96253 21.9422 7.69138C22 8.39925 22 9.27339 22 10.3572V13.6428C22 14.7266 22 15.6008 21.9422 16.3086C21.8826 17.0375 21.7568 17.6777 21.455 18.27C20.9757 19.2108 20.2108 19.9757 19.27 20.455C18.6777 20.7568 18.0375 20.8826 17.3086 20.9422C16.6008 21 15.7266 21 14.6428 21H9.35717C8.27339 21 7.39925 21 6.69138 20.9422C5.96253 20.8826 5.32234 20.7568 4.73005 20.455C3.78924 19.9757 3.02433 19.2108 2.54497 18.27C2.24318 17.6777 2.11737 17.0375 2.05782 16.3086C1.99998 15.6007 1.99999 14.7266 2 13.6428V10.3572C1.99999 9.27341 1.99998 8.39926 2.05782 7.69138C2.11737 6.96253 2.24318 6.32234 2.54497 5.73005C3.02433 4.78924 3.78924 4.02433 4.73005 3.54497C5.32234 3.24318 5.96253 3.11737 6.69138 3.05782C7.39926 2.99998 8.27341 2.99999 9.35719 3ZM6.85424 5.05118C6.24907 5.10062 5.90138 5.19279 5.63803 5.32698C5.07354 5.6146 4.6146 6.07354 4.32698 6.63803C4.19279 6.90138 4.10062 7.24907 4.05118 7.85424C4.00078 8.47108 4 9.26339 4 10.4V13.6C4 14.7366 4.00078 15.5289 4.05118 16.1458C4.10062 16.7509 4.19279 17.0986 4.32698 17.362C4.6146 17.9265 5.07354 18.3854 5.63803 18.673C5.90138 18.8072 6.24907 18.8994 6.85424 18.9488C7.17922 18.9754 7.55292 18.9882 8 18.9943V5.0057C7.55292 5.01184 7.17922 5.02462 6.85424 5.05118ZM10 5V19H14.6C15.7366 19 16.5289 18.9992 17.1458 18.9488C17.7509 18.8994 18.0986 18.8072 18.362 18.673C18.9265 18.3854 19.3854 17.9265 19.673 17.362C19.8072 17.0986 19.8994 16.7509 19.9488 16.1458C19.9992 15.5289 20 14.7366 20 13.6V10.4C20 9.26339 19.9992 8.47108 19.9488 7.85424C19.8994 7.24907 19.8072 6.90138 19.673 6.63803C19.3854 6.07354 18.9265 5.6146 18.362 5.32698C18.0986 5.19279 17.7509 5.10062 17.1458 5.05118C16.5289 5.00078 15.7366 5 14.6 5H10Z"
        fill="currentColor"
      />
    </svg>
  )
}

export const DownloadIcon = (props: LucideProps) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11.0303 8.03033C11.3232 7.73744 11.3232 7.26256 11.0303 6.96967C10.7374 6.67678 10.2626 6.67678 9.96967 6.96967L8.75 8.18934V3.75C8.75 3.33579 8.41421 3 8 3C7.58579 3 7.25 3.33579 7.25 3.75V8.18934L6.03033 6.96967C5.73744 6.67678 5.26256 6.67678 4.96967 6.96967C4.67678 7.26256 4.67678 7.73744 4.96967 8.03033L7.46967 10.5303C7.76256 10.8232 8.23744 10.8232 8.53033 10.5303L11.0303 8.03033ZM4.75 12C4.33579 12 4 12.3358 4 12.75C4 13.1642 4.33579 13.5 4.75 13.5H11.25C11.6642 13.5 12 13.1642 12 12.75C12 12.3358 11.6642 12 11.25 12H4.75Z"
      fill="currentColor"
    />
  </svg>
)

export const GlobeIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.1) translate(-1.1, -1.1)">
      <path
        d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M18.363 18.364C17.1915 19.5355 13.3925 17.636 9.87777 14.1213C6.36305 10.6066 4.46355 6.80761 5.63513 5.63604C6.8067 4.46447 10.6057 6.36396 14.1204 9.87868C17.6351 13.3934 19.5346 17.1924 18.363 18.364Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M19.779 4.2218L4.22266 19.7782"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </g>
  </svg>
)

export const SparkleIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.1, -1.1)">
        <path
          d="M12 3L13.6 7.2L17.8 8.8L13.6 10.4L12 14.6L10.4 10.4L6.2 8.8L10.4 7.2L12 3Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const SparklesIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.05) translate(-1.1, -1.1)">
        <path
          d="M11.5 3.5L12.9 7.2L16.6 8.6L12.9 10L11.5 13.7L10.1 10L6.4 8.6L10.1 7.2L11.5 3.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M18 12.5L18.8 14.6L20.9 15.4L18.8 16.2L18 18.3L17.2 16.2L15.1 15.4L17.2 14.6L18 12.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const CreateNewIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 4.75C4 3.23122 5.23122 2 6.75 2H17.25C18.7688 2 20 3.23122 20 4.75V13.8357C19.5875 13.3259 18.9568 13 18.25 13C17.0074 13 16 14.0074 16 15.25V16H15.25C14.0074 16 13 17.0074 13 18.25C13 19.4926 14.0074 20.5 15.25 20.5H16V21.25C16 21.513 16.0451 21.7654 16.128 22H6.75C5.23122 22 4 20.7688 4 19.25V4.75ZM8 6.75C8 6.33579 8.33579 6 8.75 6H15.25C15.6642 6 16 6.33579 16 6.75C16 7.16421 15.6642 7.5 15.25 7.5H8.75C8.33579 7.5 8 7.16421 8 6.75ZM8 10.75C8 10.3358 8.33579 10 8.75 10H11.25C11.6642 10 12 10.3358 12 10.75C12 11.1642 11.6642 11.5 11.25 11.5H8.75C8.33579 11.5 8 11.1642 8 10.75Z"
      fill="currentColor"
    />
    <path
      d="M19 15.25C19 14.8358 18.6642 14.5 18.25 14.5C17.8358 14.5 17.5 14.8358 17.5 15.25V17.5H15.25C14.8358 17.5 14.5 17.8358 14.5 18.25C14.5 18.6642 14.8358 19 15.25 19H17.5V21.25C17.5 21.6642 17.8358 22 18.25 22C18.6642 22 19 21.6642 19 21.25V19H21.25C21.6642 19 22 18.6642 22 18.25C22 17.8358 21.6642 17.5 21.25 17.5H19V15.25Z"
      fill="currentColor"
    />
  </svg>
)

export const CustomTerminalIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.1) translate(-1.2, -1.2)">
      <path
        d="M7.5 8L9.25 9.75L7.5 11.5M12 11.5H14M7 20H17C18.6569 20 20 18.6569 20 17V7C20 5.34315 18.6569 4 17 4H7C5.34315 4 4 5.34315 4 7V17C4 18.6569 5.34315 20 7 20Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const WriteFileIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M10 21.5H8C6.34315 21.5 5 20.1569 5 18.5V6C5 4.34315 6.34315 3 8 3H16C17.6569 3 19 4.34315 19 6V11"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 21.0002V18.6668L17.5 15.1668C18.1443 14.5225 19.189 14.5225 19.8333 15.1668C20.4777 15.8112 20.4777 16.8558 19.8333 17.5002L16.3333 21.0002H14Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="square"
      strokeLinejoin="round"
    />
    <path
      d="M9 7H15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path
      d="M9 11H11"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
)

export const CloneSiteIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M5.25 9H12.75C13.9926 9 15 10.0074 15 11.25V18.75C15 19.9926 13.9926 21 12.75 21H5.25C4.00736 21 3 19.9926 3 18.75V11.25C3 10.0074 4.00736 9 5.25 9Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 8V9"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 3H16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M21 8V10"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M16 15H15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M19 3C20.1046 3 21 3.89543 21 5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M21 13C21 14.1046 20.1046 15 19 15"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9 5C9 3.89543 9.89543 3 11 3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const MarkdownIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M16 10V14M16 14L17.5 12.75M16 14L14.5 12.75M7 14V10L9.25 12L11.5 10V14M6 5H18C19.6569 5 21 6.34315 21 8V16C21 17.6569 19.6569 19 18 19H6C4.34315 19 3 17.6569 3 16V8C3 6.34315 4.34315 5 6 5Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const PlanningIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M15 10C13.3431 10 12 8.65685 12 7M9 14C10.6569 14 12 15.3431 12 17M12 20.2422C12.7151 20.7209 13.5749 21 14.5 21C16.5553 21 18.2888 19.6221 18.8271 17.7396C20.102 17.2168 21 15.9633 21 14.5C21 13.5207 20.5978 12.6353 19.9495 12C20.5978 11.3647 21 10.4793 21 9.5C21 7.69511 19.6338 6.20931 17.8792 6.0203C17.4422 4.28478 15.8711 3 14 3C13.2714 3 12.5883 3.19479 12 3.53513M12 20.2422C11.285 20.7209 10.4251 21 9.5 21C7.44468 21 5.71119 19.6221 5.17291 17.7396C3.89797 17.2168 3 15.9633 3 14.5C3 13.5207 3.40223 12.6353 4.05051 12C3.40223 11.3647 3 10.4793 3 9.5C3 7.69511 4.36618 6.20931 6.12085 6.0203C6.55779 4.28478 8.12886 3 10 3C10.7286 3 11.4117 3.19479 12 3.53513M12 20.2422L12 3.53513"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const ComponentGenerationIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M6.70694 14.7929C6.31641 15.1834 5.68325 15.1834 5.29272 14.7929L2.45696 11.9571C2.06643 11.5666 2.06643 10.9334 2.45696 10.5429L9.70694 3.29289C9.89447 3.10536 10.1488 3 10.414 3L14.0857 3C14.3509 3 14.6052 3.10536 14.7928 3.29289L15.7927 4.29286C16.1832 4.68338 16.1832 5.31655 15.7927 5.70707L6.70694 14.7929Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M9.5 12.5L16.3358 19.3358C17.1168 20.1168 18.3832 20.1168 19.1642 19.3358L19.3358 19.1642C20.1168 18.3832 20.1168 17.1168 19.3358 16.3358L12.5 9.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const CheckIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M5 12.75L10 19L19 5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const SelectIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <circle cx="12" cy="12" r="9.25" />
    <path d="M7.75 12.9231L10.5625 15.75L15.25 8.75" />
  </svg>
)

export const AttachIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M6 11V15C6 18.3137 8.68629 21 12 21C15.3137 21 18 18.3137 18 15V7C18 4.79086 16.2091 3 14 3C11.7909 3 10 4.79086 10 7V15C10 16.1046 10.8954 17 12 17C13.1046 17 14 16.1046 14 15V7"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
)

export const NoCodeIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M7 7V8C7 9.10457 7.89543 10 9 10H18C19.1046 10 20 9.10457 20 8V6C20 4.89543 19.1046 4 18 4H9C7.89543 4 7 4.89543 7 6V7ZM7 7H5C4.44772 7 4 7.44772 4 8V10C4 11.6569 5.34315 13 7 13H13V15.5M15 21V18C15 16.8954 14.1046 16 13 16C11.8954 16 11 16.8954 11 18V21" />
    </g>
  </svg>
)

export const CodePasteIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="scale(1) translate(-1.8, -1.8)">
      <path d="M12 5H6C4.34315 5 3 6.34315 3 8V16C3 17.6569 4.34315 19 6 19H12M16 5H18C19.6569 5 21 6.34315 21 8V16C21 17.6569 19.6569 19 18 19H16M16 5V2.5M16 5V19M16 19V21.5M8 9.5L10.5 12L8 14.5" />
    </g>
  </svg>
)

export const CSSPasteIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="scale(1.1) translate(-1.8, -1.8)">
      <path d="M12 5H6C4.34315 5 3 6.34315 3 8V16C3 17.6569 4.34315 19 6 19H12M16 5H18C19.6569 5 21 6.34315 21 8V16C21 17.6569 19.6569 19 18 19H16M16 5V2.5M16 5V19M16 19V21.5M8 9.5L10.5 12L8 14.5" />
    </g>
  </svg>
)

export const CodeIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M10 20L14 4M18 8.00004L19.9775 9.75781C21.32 10.9512 21.32 13.0489 19.9775 14.2423L18 16M6 16L4.02251 14.2423C2.67996 13.0489 2.67996 10.9512 4.02251 9.75781L6 8.00004" />
    </g>
  </svg>
)

export const FilePlusIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M11 21H8C6.34315 21 5 19.6569 5 18V6C5 4.34315 6.34315 3 8 3H16C17.6569 3 19 4.34315 19 6V11" />
      <path d="M18 15V18M18 18V21M18 18H15M18 18H21" />
      <path d="M9 7H15" />
      <path d="M9 11H11" />
    </g>
  </svg>
)

export const FilePageIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M9 7H15M9 11H15M9 15H11M7 21H17C18.1046 21 19 20.1046 19 19V5C19 3.89543 18.1046 3 17 3H7C5.89543 3 5 3.89543 5 5V19C5 20.1046 5.89543 21 7 21Z" />
    </g>
  </svg>
)

export const BlankProjectIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    {...props}
  >
    <path
      d="M21 7C21 5.89543 20.1046 5 19 5H5C3.89543 5 3 5.89543 3 7V12.1429C3 14.571 4.14321 16.8574 6.08571 18.3143C6.67919 18.7594 7.40102 19 8.14286 19H19C20.1046 19 21 18.1046 21 17V7Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3 7.00005V6.85791C3 9.51008 4.05357 11.0536 5.92893 12.929L7 14C6 15.5 6 19 8.5 19"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const HomeIconCustom = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
    </g>
  </svg>
)

export const ProfileIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M17.8841 18.8103C16.5544 17.0943 14.4995 16 12 16C9.50054 16 7.44562 17.0943 6.11594 18.8103M17.8841 18.8103C19.7925 17.16 21 14.721 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 14.721 4.20753 17.16 6.11594 18.8103M17.8841 18.8103C16.3063 20.1747 14.2495 21 12 21C9.75046 21 7.69368 20.1747 6.11594 18.8103" />
      <path d="M15 10C15 11.6569 13.6569 13 12 13C10.3431 13 9 11.6569 9 10C9 8.34315 10.3431 7 12 7C13.6569 7 15 8.34315 15 10Z" />
    </g>
  </svg>
)

export const DocumentIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M13 3.5V7C13 8.10457 13.8954 9 15 9H18.5M9 13H12M9 17H15.5M8 3H12.1716C12.702 3 13.2107 3.21071 13.5858 3.58579L18.4142 8.41421C18.7893 8.78929 19 9.29799 19 9.82843V18C19 19.6569 17.6569 21 16 21H8C6.34315 21 5 19.6569 5 18V6C5 4.34315 6.34315 3 8 3Z" />
    </g>
  </svg>
)

export const FilesIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.2) translate(-1.8, -1.8)">
      <path d="M17 18C17 19.6569 15.6569 21 14 21H8C6.34315 21 5 19.6569 5 18V9C5 7.34315 6.34315 6 8 6M17 18H11C9.34315 18 8 16.6569 8 15V6M17 18C18.6569 18 20 16.6569 20 15V8M8 6C8 4.34315 9.34315 3 11 3H15M15 3L20 8M15 3V6C15 7.10457 15.8954 8 17 8H20" />
    </g>
  </svg>
)

export const SettingsIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M7.67668 5.32539L7.30515 5.23965C6.72652 5.10612 6.11991 5.28009 5.7 5.7C5.28009 6.11991 5.10612 6.72651 5.23965 7.30515L5.32539 7.67668C5.55082 8.65357 5.148 9.668 4.31382 10.2241L3.74885 10.6008C3.28101 10.9127 3 11.4377 3 12C3 12.5623 3.28101 13.0873 3.74885 13.3992L4.31382 13.7759C5.148 14.332 5.55082 15.3464 5.32539 16.3233L5.23965 16.6949C5.10612 17.2735 5.28009 17.8801 5.7 18.3C6.11991 18.7199 6.72651 18.8939 7.30515 18.7604L7.67668 18.6746C8.65357 18.4492 9.668 18.852 10.2241 19.6862L10.6008 20.2512C10.9127 20.719 11.4377 21 12 21C12.5623 21 13.0873 20.719 13.3992 20.2512L13.7759 19.6862C14.332 18.852 15.3464 18.4492 16.3233 18.6746L16.6949 18.7604C17.2735 18.8939 17.8801 18.7199 18.3 18.3C18.7199 17.8801 18.8939 17.2735 18.7604 16.6949L18.6746 16.3233C18.4492 15.3464 18.852 14.332 19.6862 13.7759L20.2512 13.3992C20.719 13.0873 21 12.5623 21 12C21 11.4377 20.719 10.9127 20.2512 10.6008L19.6862 10.2241C18.852 9.668 18.4492 8.65357 18.6746 7.67668L18.7604 7.30515C18.8939 6.72652 18.7199 6.11991 18.3 5.7C17.8801 5.28009 17.2735 5.10612 16.6949 5.23965L16.3233 5.32539C15.3464 5.55082 14.332 5.148 13.7759 4.31382L13.3992 3.74884C13.0873 3.28101 12.5623 3 12 3C11.4377 3 10.9127 3.28101 10.6008 3.74885L10.2241 4.31382C9.668 5.148 8.65357 5.55082 7.67668 5.32539Z" />
      <path d="M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z" />
    </g>
  </svg>
)

export const EditIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M13.5 5.99997L15.25 4.24997C16.4926 3.00733 18.5074 3.00733 19.75 4.24997C20.9926 5.49261 20.9926 7.50733 19.75 8.74997L18 10.5M13.5 5.99997L3.29289 16.2071C3.10536 16.3946 3 16.649 3 16.9142V21H7.08579C7.351 21 7.60536 20.8946 7.79289 20.7071L18 10.5M13.5 5.99997L18 10.5" />
    </g>
  </svg>
)

export const TrashIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M5 6.5L5.80734 18.2064C5.91582 19.7794 7.22348 21 8.80023 21H15.1998C16.7765 21 18.0842 19.7794 18.1927 18.2064L19 6.5" />
      <path d="M10 11V16" />
      <path d="M14 11V16" />
      <path d="M3.5 6H20.5" />
      <path d="M8.07092 5.74621C8.42348 3.89745 10.0485 2.5 12 2.5C13.9515 2.5 15.5765 3.89745 15.9291 5.74621" />
    </g>
  </svg>
)

export const ThemeIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path d="M6 17.5V20C6 20.5523 6.44772 21 7 21H17C17.5523 21 18 20.5523 18 20V17.5M14 15H16M8 6H16V12H8V6ZM5 15V6C5 4.34315 6.34315 3 8 3H16C17.6569 3 19 4.34315 19 6V15C19 16.6569 17.6569 18 16 18H8C6.34315 18 5 16.6569 5 15Z" />
    </g>
  </svg>
)

export function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="25"
      height="25"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.1)">
        <path
          d="M8 3H7.8C6.11984 3 5.27976 3 4.63803 3.32698C4.07354 3.6146 3.6146 4.07354 3.32698 4.63803C3 5.27976 3 6.11984 3 7.8V14.2C3 15.8802 3 16.7202 3.32698 17.362C3.6146 17.9265 4.07354 18.3854 4.63803 18.673C5.27976 19 6.11984 19 7.8 19H14.2C15.8802 19 16.7202 19 17.362 18.673C17.9265 18.3854 18.3854 17.9265 18.673 17.362C19 16.7202 19 15.8802 19 14.2V14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13 3H19M19 3V9M19 3L10 12"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <path
        d="M19.6848 9.49288L10.6475 3.55409C8.65262 2.24315 6 3.67411 6 6.06121V17.9388C6 20.3259 8.65263 21.7568 10.6475 20.4459L19.6848 14.5071C21.4881 13.3221 21.4881 10.6779 19.6848 9.49288Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const PromptCopyIcon = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M8 5C8 3.89543 8.89543 3 10 3H14C15.1046 3 16 3.89543 16 5V7H8V5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19.2405 16.1852L18.5436 14.3733C18.4571 14.1484 18.241 14 18 14C17.759 14 17.5429 14.1484 17.4564 14.3733L16.7595 16.1852C16.658 16.4493 16.4493 16.658 16.1852 16.7595L14.3733 17.4564C14.1484 17.5429 14 17.759 14 18C14 18.241 14.1484 18.4571 14.3733 18.5436L16.1852 19.2405C16.4493 19.342 16.658 19.5507 16.7595 19.8148L17.4564 21.6267C17.5429 21.8516 17.759 22 18 22C18.241 22 18.4571 21.8516 18.5436 21.6267L19.2405 19.8148C19.342 19.5507 19.5507 19.342 19.8148 19.2405L21.6267 18.5436C21.8516 18.4571 22 18.241 22 18C22 17.759 21.8516 17.5429 21.6267 17.4564L19.8148 16.7595C19.5507 16.658 19.342 16.4493 19.2405 16.1852Z"
        fill="currentColor"
      />
      <path
        d="M16 5H18C19.1046 5 20 5.89543 20 7V11M8 5H6C4.89543 5 4 5.89543 4 7V19C4 20.1046 4.89543 21 6 21H12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const EyeIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(0.9)">
      <path
        d="M12 3C17.39 3 21.875 6.55 22 12C21.875 17.45 17.39 21 12 21C6.61 21 2.125 17.45 2 12C2.125 6.55 6.61 3 12 3Z"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12"
        r="3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const SavedBookmarkFilledIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M8 2C5.79086 2 4 3.79086 4 6V19.9948C4 21.6146 5.82485 22.5625 7.15006 21.6311L10.8499 19.0306C11.54 18.5456 12.46 18.5456 13.1501 19.0306L16.8499 21.6311C18.1751 22.5625 20 21.6146 20 19.9948V6C20 3.79086 18.2091 2 16 2H8Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const LightbulbIcon = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M10 21H14M15.6076 15C17.6404 13.7751 19 11.5463 19 9C19 5.13401 15.866 2 12 2C8.13401 2 5 5.13401 5 9C5 11.5463 6.35958 13.7751 8.39241 15M15.6076 15C15.4111 15.1184 15.2084 15.2274 15 15.3264V16.5C15 17.3284 14.3284 18 13.5 18H10.5C9.67157 18 9 17.3284 9 16.5V15.3264C8.7916 15.2274 8.58886 15.1184 8.39241 15M15.6076 15H8.39241"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface ScreenIconProps {
  className?: string
}

export function ScreenIcon({ className }: ScreenIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M8 4H6C4.89543 4 4 4.89543 4 6V8M16 4H18C19.1046 4 20 4.89543 20 6V8M20 16V18C20 19.1046 19.1046 20 18 20H16M8 20H6C4.89543 20 4 19.1046 4 18V16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

interface AgentCursorSparkIconProps {
  className?: string
}

export function AgentCursorSparkIcon({ className }: AgentCursorSparkIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M19.1275 8.15434L19.4844 8.27073C21.2921 8.86019 21.3347 11.402 19.5479 12.0518L14.6725 13.8246C14.3945 13.9257 14.1755 14.1447 14.0744 14.4227L12.2036 19.5674C11.5647 21.3244 9.07915 21.3223 8.44327 19.5642L3.47165 5.81916C2.89165 4.21564 4.45568 2.66835 6.05286 3.26556L7.38283 3.76285"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16.5669 5.45466C14.5765 4.96575 14.0343 4.4235 13.5453 2.43314C13.4834 2.18096 13.2597 2 13 2C12.7403 2 12.5166 2.18096 12.4547 2.43314C11.9657 4.4235 11.4235 4.96575 9.43314 5.45466C9.18096 5.5166 9 5.74032 9 6C9 6.25968 9.18096 6.4834 9.43314 6.54534C11.4235 7.03425 11.9657 7.5765 12.4547 9.56686C12.5166 9.81904 12.7403 10 13 10C13.2597 10 13.4834 9.81904 13.5453 9.56686C14.0343 7.5765 14.5765 7.03425 16.5669 6.54534C16.819 6.4834 17 6.25968 17 6C17 5.74032 16.819 5.5166 16.5669 5.45466Z"
          fill="currentColor"
        />
      </g>
    </svg>
  )
}

interface CanvasFilesIconProps {
  className?: string
}

export function CanvasFilesIcon({ className }: CanvasFilesIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M16 18H19C20.1046 18 21 17.1046 21 16V7C21 5.89543 20.1046 5 19 5H12M16 18L17 21M16 18H8M8 18H5C3.89543 18 3 17.1046 3 16V7C3 5.89543 3.89543 5 5 5H12M8 18L7 21M12 18V20M12 5V3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

interface ComponentIconProps {
  className?: string
}

export function ComponentIcon({ className }: ComponentIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.15) translate(-1.2, -1.2)">
        <path
          d="M6 5H9.5V4.5C9.5 3.11929 10.6193 2 12 2C13.3807 2 14.5 3.11929 14.5 4.5V5H18C19.1046 5 20 5.89543 20 7V9.5H19.5C18.1193 9.5 17 10.6193 17 12C17 13.3807 18.1193 14.5 19.5 14.5H20V17C20 18.1046 19.1046 19 18 19H6C4.89543 19 4 18.1046 4 17V7C4 5.89543 4.89543 5 6 5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function PauseIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <path
        d="M5 6C5 4.89543 5.89543 4 7 4C8.10457 4 9 4.89543 9 6V18C9 19.1046 8.10457 20 7 20C5.89543 20 5 19.1046 5 18V6Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M15 6C15 4.89543 15.8954 4 17 4C18.1046 4 19 4.89543 19 6V18C19 19.1046 18.1046 20 17 20C15.8954 20 15 19.1046 15 18V6Z"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  )
}

export function VolumeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="translate(0, 1) scale(1.1)" transform-origin="center">
        <path
          d="M19.071 4.92968C20.8807 6.73932 22 9.23932 22 12.0007C22 14.7622 20.8807 17.2622 19.071 19.0718M15.8891 8.11132C16.8844 9.10662 17.5 10.4816 17.5 12.0004C17.5 13.5192 16.8844 14.8942 15.8891 15.8895M4 7.99999H5.2759C5.74377 7.99999 6.19684 7.83596 6.55627 7.53643L10.3598 4.36681C11.0111 3.82403 12 4.28719 12 5.13503V18.8649C12 19.7128 11.0111 20.1759 10.3598 19.6332L6.55627 16.4635C6.19684 16.164 5.74377 16 5.2759 16H4C2.89543 16 2 15.1046 2 14V9.99999C2 8.89542 2.89543 7.99999 4 7.99999Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const PlusIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M12 4V12M12 12V20M12 12H4M12 12H20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export const SearchIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M11 18C14.866 18 18 14.866 18 11C18 7.13401 14.866 4 11 4C7.13401 4 4 7.13401 4 11C4 14.866 7.13401 18 11 18Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M20 20L16.05 16.05"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </g>
  </svg>
)

export const VariantIcon = (props: React.SVGProps<SVGSVGElement>) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g transform="scale(1.05) translate(-1.5, -1.5)">
        <circle
          cx="6.5"
          cy="6"
          r="2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx="6.5"
          cy="18"
          r="2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx="17.5"
          cy="6"
          r="2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.5 8V16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M17.5 8V10C17.5 11.1046 16.6046 12 15.5 12H8.5C7.39543 12 6.5 12.8954 6.5 14V16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const VideoIcon = (props: IconProps) => {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M5 4H19M11 11.5V15.5L13.5 13.5L11 11.5ZM6 20H18C19.6569 20 21 18.6569 21 17V10C21 8.34315 19.6569 7 18 7H6C4.34315 7 3 8.34315 3 10V17C3 18.6569 4.34315 20 6 20Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const MixedIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M7.43021 10.0321C7.15369 9.41121 7 8.72355 7 8C7 5.23858 9.23858 3 12 3C14.7614 3 17 5.23858 17 8C17 8.72355 16.8463 9.41121 16.5698 10.0321M7.43021 10.0321C4.93709 10.3149 3 12.4312 3 15C3 17.7614 5.23858 20 8 20C9.6356 20 11.0878 19.2147 12 18.0005M7.43021 10.0321C8.13538 11.6155 9.63934 12.7647 11.4302 12.9679M16.5698 10.0321C16.3828 10.0109 16.1927 10 16 10C14.3644 10 12.9122 10.7853 12 11.9995M16.5698 10.0321C19.0629 10.3149 21 12.4312 21 15C21 17.7614 18.7614 20 16 20C14.3644 20 12.9122 19.2147 12 18.0005M12 11.9995C11.7756 12.2981 11.5839 12.6227 11.4302 12.9679M12 11.9995C12.2244 12.2981 12.4161 12.6227 12.5698 12.9679M11.4302 12.9679C11.6172 12.9891 11.8073 13 12 13C12.1927 13 12.1927 12.9891 12.5698 12.9679M12.5698 12.9679C12.8463 13.5888 13 14.2764 13 15C13 16.1258 12.6279 17.1647 12 18.0005"
          stroke="currentColor"
          strokeWidth="2"
        />
      </g>
    </svg>
  )
}

export const ClickIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.8, -1.8)">
        <path
          d="M11 3V4.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16.6569 5.34375L15.5962 6.40441"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.40392 15.5957L5.34326 16.6564"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.5 11H3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.40392 6.40343L5.34326 5.34277"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.3876 11.3609L14.1309 20.8179C14.2827 21.2014 14.8074 21.2465 15.0225 20.8946L17.1554 17.4043C17.2175 17.3028 17.3028 17.2175 17.4043 17.1554L20.8946 15.0225C21.2465 14.8074 21.2014 14.2827 20.8179 14.1309L11.3609 10.3876C10.7502 10.1458 10.1458 10.7502 10.3876 11.3609Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const CopyIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M15 9V5.25C15 4.00736 13.9926 3 12.75 3H5.25C4.00736 3 3 4.00736 3 5.25V12.75C3 13.9926 4.00736 15 5.25 15H9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M18.75 9H11.25C10.0074 9 9 10.0074 9 11.25V18.75C9 19.9926 10.0074 21 11.25 21H18.75C19.9926 21 21 19.9926 21 18.75V11.25C21 10.0074 19.9926 9 18.75 9Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const SaveIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M8 4V7C8 7.55228 8.44772 8 9 8H15C15.5523 8 16 7.55228 16 7V4M20 8.24264V17C20 18.6569 18.6569 20 17 20H7C5.34315 20 4 18.6569 4 17V7C4 5.34315 5.34315 4 7 4H15.7574C16.553 4 17.3161 4.31607 17.8787 4.87868L19.1213 6.12132C19.6839 6.68393 20 7.44699 20 8.24264ZM8 14V19C8 19.5523 8.44772 20 9 20H15C15.5523 20 16 19.5523 16 19V14C16 13.4477 15.5523 13 15 13H9C8.44772 13 8 13.4477 8 14Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const UndoIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M6.49977 5L3.56043 7.93934C2.97465 8.52513 2.97465 9.47487 3.56043 10.0607L6.49977 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 9H16.5C18.9853 9 21 11.0147 21 13.5C21 15.9853 18.9853 18 16.5 18H12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const KeyboardIcon = (props: IconProps) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M6 13.125C6.48325 13.125 6.875 13.5168 6.875 14C6.875 14.4832 6.48325 14.875 6 14.875C5.51675 14.875 5.125 14.4832 5.125 14C5.125 13.5168 5.51675 13.125 6 13.125ZM18 13.125C18.4832 13.125 18.875 13.5168 18.875 14C18.875 14.4832 18.4832 14.875 18 14.875C17.5168 14.875 17.125 14.4832 17.125 14C17.125 13.5168 17.5168 13.125 18 13.125ZM6 9.125C6.48325 9.125 6.875 9.5168 6.875 10C6.875 10.4832 6.48325 10.875 6 10.875C5.51675 10.875 5.125 10.4832 5.125 10C5.125 9.5168 5.51675 9.125 6 9.125ZM10 9.125C10.4832 9.125 10.875 9.5168 10.875 10C10.875 10.4832 10.4832 10.875 10 10.875C9.51675 10.875 9.125 10.4832 9.125 10C9.125 9.5168 9.51675 9.125 10 9.125ZM14 9.125C14.4832 9.125 14.875 9.5168 14.875 10C14.875 10.4832 14.4832 10.875 14 10.875C13.5168 10.875 13.125 10.4832 13.125 10C13.125 9.5168 13.5168 9.125 14 9.125ZM18 9.125C18.4832 9.125 18.875 9.5168 18.875 10C18.875 10.4832 18.4832 10.875 18 10.875C17.5168 10.875 17.125 10.4832 17.125 10C17.125 9.5168 17.5168 9.125 18 9.125Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.75"
        strokeLinecap="square"
      />
      <path
        d="M10 13C9.44772 13 9 13.4477 9 14C9 14.5523 9.44772 15 10 15V13ZM14 15C14.5523 15 15 14.5523 15 14C15 13.4477 14.5523 13 14 13V15ZM10 15H14V13H10V15ZM6.8 7H17.2V5H6.8V7ZM21 10.8V13.2H23V10.8H21ZM17.2 17H6.8V19H17.2V17ZM3 13.2V10.8H1V13.2H3ZM6.8 17C5.94342 17 5.36113 16.9992 4.91104 16.9624C4.47262 16.9266 4.24842 16.8617 4.09202 16.782L3.18404 18.564C3.66937 18.8113 4.18608 18.9099 4.74817 18.9558C5.2986 19.0008 5.97642 19 6.8 19V17ZM1 13.2C1 14.0236 0.999223 14.7014 1.04419 15.2518C1.09012 15.8139 1.18868 16.3306 1.43597 16.816L3.21799 15.908C3.1383 15.7516 3.07337 15.5274 3.03755 15.089C3.00078 14.6389 3 14.0566 3 13.2H1ZM4.09202 16.782C3.71569 16.5903 3.40973 16.2843 3.21799 15.908L1.43597 16.816C1.81947 17.5686 2.43139 18.1805 3.18404 18.564L4.09202 16.782ZM21 13.2C21 14.0566 20.9992 14.6389 20.9624 15.089C20.9266 15.5274 20.8617 15.7516 20.782 15.908L22.564 16.816C22.8113 16.3306 22.9099 15.8139 22.9558 15.2518C23.0008 14.7014 23 14.0236 23 13.2H21ZM17.2 19C18.0236 19 18.7014 19.0008 19.2518 18.9558C19.8139 18.9099 20.3306 18.8113 20.816 18.564L19.908 16.782C19.7516 16.8617 19.5274 16.9266 19.089 16.9624C18.6389 16.9992 18.0566 17 17.2 17V19ZM20.782 15.908C20.5903 16.2843 20.2843 16.5903 19.908 16.782L20.816 18.564C21.5686 18.1805 22.1805 17.5686 22.564 16.816L20.782 15.908ZM17.2 7C18.0566 7 18.6389 7.0008 19.089 7.0376C19.5274 7.0734 19.7516 7.1383 19.908 7.218L20.816 5.43597C20.3306 5.18868 19.8139 5.09012 19.2518 5.04419C18.7014 4.99922 18.0236 5 17.2 5V7ZM23 10.8C23 9.9764 23.0008 9.2986 22.9558 8.7482C22.9099 8.1861 22.8113 7.6694 22.564 7.184L20.782 8.092C20.8617 8.2484 20.9266 8.4726 20.9624 8.911C20.9992 9.3611 21 9.9434 21 10.8H23ZM19.908 7.218C20.2843 7.4097 20.5903 7.7157 20.782 8.092L22.564 7.184C22.1805 6.43139 21.5686 5.81947 20.816 5.43597L19.908 7.218ZM6.8 5C5.97642 5 5.2986 4.99922 4.74817 5.04419C4.18608 5.09012 3.66937 5.18868 3.18404 5.43597L4.09202 7.218C4.24842 7.1383 4.47262 7.0734 4.91104 7.0376C5.36113 7.0008 5.94342 7 6.8 7V5ZM3 10.8C3 9.9434 3.00078 9.3611 3.03755 8.911C3.07337 8.4726 3.1383 8.2484 3.21799 8.092L1.43597 7.184C1.18868 7.6694 1.09012 8.1861 1.04419 8.7482C0.999223 9.2986 1 9.9764 1 10.8H3ZM3.18404 5.43597C2.43139 5.81947 1.81947 6.43139 1.43597 7.184L3.21799 8.092C3.40973 7.7157 3.71569 7.4097 4.09202 7.218L3.18404 5.43597Z"
        fill="currentColor"
      />
    </svg>
  )
}

export const KeyboardFilledIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M19 3C19 2.44772 18.5523 2 18 2C17.4477 2 17 2.44772 17 3V3.5C17 3.77614 16.7761 4 16.5 4H8C6.34315 4 5 5.34315 5 7V8H4C2.34315 8 1 9.34315 1 11V19C1 20.6569 2.34315 22 4 22H20C21.6569 22 23 20.6569 23 19V11C23 9.34315 21.6569 8 20 8H7V7C7 6.44772 7.44772 6 8 6H16.5C17.8807 6 19 4.88071 19 3.5V3ZM10 16C9.44771 16 9 16.4477 9 17C9 17.5523 9.44771 18 10 18H14C14.5523 18 15 17.5523 15 17C15 16.4477 14.5523 16 14 16H10ZM4.75 13C4.75 13.6904 5.30964 14.25 6 14.25C6.69036 14.25 7.25 13.6904 7.25 13C7.25 12.3096 6.69036 11.75 6 11.75C5.30964 11.75 4.75 12.3096 4.75 13ZM16.75 13C16.75 13.6904 17.3096 14.25 18 14.25C18.6904 14.25 19.25 13.6904 19.25 13C19.25 12.3096 18.6904 11.75 18 11.75C17.3096 11.75 16.75 12.3096 16.75 13ZM14 14.25C13.3096 14.25 12.75 13.6904 12.75 13C12.75 12.3096 13.3096 11.75 14 11.75C14.6904 11.75 15.25 12.3096 15.25 13C15.25 13.6904 14.6904 14.25 14 14.25ZM8.75 13C8.75 13.6904 9.30964 14.25 10 14.25C10.6904 14.25 11.25 13.6904 11.25 13C11.25 12.3096 10.6904 11.75 10 11.75C9.30964 11.75 8.75 12.3096 8.75 13ZM6 18.25C5.30964 18.25 4.75 17.6904 4.75 17C4.75 16.3096 5.30964 15.75 6 15.75C6.69036 15.75 7.25 16.3096 7.25 17C7.25 17.6904 6.69036 18.25 6 18.25ZM16.75 17C16.75 17.6904 17.3096 18.25 18 18.25C18.6904 18.25 19.25 17.6904 19.25 17C19.25 16.3096 18.6904 15.75 18 15.75C17.3096 15.75 16.75 16.3096 16.75 17Z"
        fill="currentColor"
      />
    </svg>
  )
}

export const BookIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M9 3.5H7.5C5.84315 3.5 4.5 4.84315 4.5 6.5V17.5C4.5 19.1569 5.84315 20.5 7.5 20.5H9M9 3.5H16.5C18.1569 3.5 19.5 4.84315 19.5 6.5V17.5C19.5 19.1569 18.1569 20.5 16.5 20.5H9M9 3.5V20.5M13 8H15.5M13 12H15.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const DesignModeIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.2, -1.2)">
        <path
          d="M3 12C3 16.6944 7.02944 20.5 12 20.5C14.8273 20.5 11 18 12 16C13.6125 12.7751 21 18.9062 21 12C21 7.30558 16.9706 3.5 12 3.5C7.02944 3.5 3 7.30558 3 12Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
        />
        <path
          d="M7.5 10.75C8.32843 10.75 9 11.4216 9 12.25C9 13.0784 8.32843 13.75 7.5 13.75C6.67157 13.75 6 13.0784 6 12.25C6 11.4216 6.67157 10.75 7.5 10.75Z"
          fill="currentColor"
        />
        <path
          d="M15.5 8C16.3284 8 17 8.67157 17 9.5C17 10.3284 16.3284 11 15.5 11C14.6716 11 14 10.3284 14 9.5C14 8.67157 14.6716 8 15.5 8Z"
          fill="currentColor"
        />
        <path
          d="M10.5 6.5C11.3284 6.5 12 7.17157 12 8C12 8.82843 11.3284 9.5 10.5 9.5C9.67157 9.5 9 8.82843 9 8C9 7.17157 9.67157 6.5 10.5 6.5Z"
          fill="currentColor"
        />
      </g>
    </svg>
  )
}

export const BackspaceIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M11.2484 10L15.25 14.0017"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15.2517 10L11.25 14.0017"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.09992 6.09578L3.81421 10.0958C2.90511 11.2025 2.90511 12.7975 3.81421 13.9042L7.09992 17.9042C7.66976 18.5979 8.52034 19 9.4181 19H18C19.6569 19 21 17.6569 21 16V8C21 6.34315 19.6569 5 18 5H9.4181C8.52034 5 7.66976 5.40206 7.09992 6.09578Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const OptionIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M4 5H6.25903C7.3356 5 8.32963 5.57686 8.86376 6.51158L15.1362 17.4884C15.6704 18.4231 16.6644 19 17.741 19H20"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20 5H16"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const CmdIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M9 9V6.5C9 5.11929 7.88071 4 6.5 4C5.11929 4 4 5.11929 4 6.5C4 7.88071 5.11929 9 6.5 9H9ZM9 9H15M9 9V15M15 9V6.5C15 5.11929 16.1193 4 17.5 4C18.8807 4 20 5.11929 20 6.5C20 7.88071 18.8807 9 17.5 9H15ZM15 9V15M15 15H9M15 15V17.5C15 18.8807 16.1193 20 17.5 20C18.8807 20 20 18.8807 20 17.5C20 16.1193 18.8807 15 17.5 15H15ZM9 15V17.5C9 18.8807 7.88071 20 6.5 20C5.11929 20 4 18.8807 4 17.5C4 16.1193 5.11929 15 6.5 15H9Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="square"
      />
    </svg>
  )
}

export const ShiftIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M2.40406 11.2615L11.3257 3.11564C11.7076 2.76695 12.2924 2.76695 12.6743 3.11564L21.5959 11.2615C22.2702 11.8771 21.8347 13 20.9217 13H17V17C17 18.6569 15.6569 20 14 20H10C8.34315 20 7 18.6569 7 17V13H3.07832C2.16535 13 1.72984 11.8771 2.40406 11.2615Z"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const ControlIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M6 14L12 8L18 14"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export const FocusIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M4 8V7C4 5.34315 5.34315 4 7 4H8M4 16V17C4 18.6569 5.34315 20 7 20H8M16 4H17C18.6569 4 20 5.34315 20 7V8M20 16V17C20 18.6569 18.6569 20 17 20H16M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3431 10.3431 9 12 9C13.6569 9 15 10.3431 15 12Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const ClipboardIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M9 5H8C6.34315 5 5 6.34315 5 8V18C5 19.6569 6.34315 21 8 21H16C17.6569 21 19 19.6569 19 18V8C19 6.34315 17.6569 5 16 5H15"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M9 6C9 4.34315 10.3431 3 12 3C13.6569 3 15 4.34315 15 6V7H9V6Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export const ImageIcon = (props: IconProps) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M4 7C4 5.34315 5.34315 4 7 4H17C18.6569 4 20 5.34315 20 7V17C20 18.6569 18.6569 20 17 20H7C5.34315 20 4 18.6569 4 17V7Z"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M16 20L10.1213 14.1214C8.94975 12.9498 7.05025 12.9498 5.87868 14.1214L4 16"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M14.5 11.5C15.6046 11.5 16.5 10.6046 16.5 9.5C16.5 8.39543 15.6046 7.5 14.5 7.5C13.3954 7.5 12.5 8.39543 12.5 9.5C12.5 10.6046 13.3954 11.5 14.5 11.5Z"
          stroke="currentColor"
          strokeWidth="2"
        />
      </g>
    </svg>
  )
}

export const ClipboardCheckIcon = (props: IconProps) => {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M9 5H8C6.34315 5 5 6.34315 5 8V18C5 19.6569 6.34315 21 8 21H16C17.6569 21 19 19.6569 19 18V8C19 6.34315 17.6569 5 16 5H15"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M9 6C9 4.34315 10.3431 3 12 3C13.6569 3 15 4.34315 15 6V7H9V6Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M9.5 13.75L11 15.25L14.5 11.75"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function MagnetIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <g transform="scale(1.2) translate(-1.8, -1.8)">
        <path
          d="M19 2.75C20.2426 2.75 21.25 3.75736 21.25 5C21.25 6.24264 20.2426 7.25 19 7.25C17.7574 7.25 16.75 6.24264 16.75 5C16.75 3.75736 17.7574 2.75 19 2.75Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M5.56687 18.4341C3.14698 16.0142 3.14698 12.0908 5.56687 9.67087L9.40078 5.83697C10.1066 5.13117 11.2509 5.13117 11.9567 5.83697C12.6625 6.54277 12.6625 7.6871 11.9567 8.3929L8.12281 12.2268C7.11452 13.2351 7.11452 14.8699 8.12281 15.8781C9.1311 16.8864 10.7659 16.8864 11.7741 15.8781L15.608 12.0442C16.3139 11.3384 17.4582 11.3384 18.164 12.0442C18.8698 12.75 18.8698 13.8944 18.164 14.6002L14.3301 18.4341C13.1201 19.644 11.5343 20.249 9.94848 20.249C8.36265 20.249 6.77682 19.644 5.56687 18.4341Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M13.9648 13.6875L16.5208 16.2434"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="M7.75781 7.47998L10.3137 10.0359"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </g>
    </svg>
  )
}

export const EnterIcon = (props: LucideProps) => (
  <svg
    data-testid="geist-icon"
    height="16"
    strokeLinejoin="round"
    viewBox="0 0 16 16"
    width="16"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13.5 3V2.25H15V3V10C15 10.5523 14.5523 11 14 11H3.56068L5.53035 12.9697L6.06068 13.5L5.00002 14.5607L4.46969 14.0303L1.39647 10.9571C1.00595 10.5666 1.00595 9.93342 1.39647 9.54289L4.46969 6.46967L5.00002 5.93934L6.06068 7L5.53035 7.53033L3.56068 9.5H13.5V3Z"
      fill="currentColor"
    />
  </svg>
)

export const DatabaseSearchIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M18 13V17.9994C18 19.2029 17.282 20.3109 16.1078 20.5748C14.9071 20.8448 13.5019 21 12 21C10.4981 21 9.09291 20.8448 7.89219 20.5748C6.718 20.3109 6 19.2029 6 17.9994V13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 11C20 12.1046 16.4183 13 12 13C7.58172 13 4 12.1046 4 11C4 9.89543 7.58172 9 12 9C16.4183 9 20 9.89543 20 11Z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M13.5528 1.8943C13.7371 1.52578 14.2631 1.52581 14.4474 1.8943L14.9259 2.8504C14.9743 2.94717 15.0528 3.02566 15.1496 3.07405L16.1057 3.55259C16.4742 3.73686 16.4742 4.26289 16.1057 4.44716L15.1496 4.9257C15.0528 4.97408 14.9743 5.05258 14.9259 5.14934L14.4474 6.10544C14.2631 6.47399 13.7371 6.47399 13.5528 6.10544L13.0743 5.14934C13.0259 5.05258 12.9474 4.97408 12.8506 4.9257L11.8945 4.44716C11.5261 4.26287 11.526 3.73685 11.8945 3.55259L12.8506 3.07405C12.9474 3.02566 13.0259 2.94717 13.0743 2.8504L13.5528 1.8943Z"
        fill="currentColor"
      />
      <path
        d="M9.35797 3.21521C9.21044 2.92083 8.78961 2.92072 8.64217 3.21521L8.22617 4.0472C8.18747 4.1246 8.12488 4.1872 8.04747 4.2259L7.21546 4.64189C6.92096 4.78932 6.92107 5.21014 7.21546 5.35767L8.04747 5.77366L8.10313 5.80686C8.15513 5.8444 8.19716 5.89446 8.22617 5.95236L8.40292 6.30683L8.64217 6.78435C8.78041 7.06081 9.15955 7.07816 9.3277 6.8361L9.35797 6.78435L9.77397 5.95236C9.81266 5.87506 9.87537 5.81235 9.95268 5.77366L10.3072 5.59594L10.7847 5.35767C11.0795 5.21025 11.0795 4.78929 10.7847 4.64189L9.95268 4.2259C9.89478 4.19689 9.84472 4.15486 9.80718 4.10286L9.77397 4.0472L9.35797 3.21521Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const SaveForLaterIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M19 19.9948V6C19 4.34315 17.6569 3 16 3H8C6.34315 3 5 4.34315 5 6V19.9948C5 20.8047 5.91243 21.2787 6.57503 20.813L10.2749 18.2125C11.3099 17.485 12.6901 17.485 13.7251 18.2125L17.425 20.813C18.0876 21.2787 19 20.8047 19 19.9948Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const SendBookmarkIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M19 9.05V6C19 4.34315 17.6569 3 16 3H8C6.34315 3 5 4.34315 5 6V13.95M19 14V19.9948C19 20.8047 18.0876 21.2787 17.425 20.813L13.7251 18.2125C12.6901 17.485 11.3099 17.485 10.2749 18.2125L6.57503 20.813C5.91243 21.2787 5 20.8047 5 19.9948V19"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M1.66965 14.0561C1.14837 14.2386 0.873694 14.8091 1.05614 15.3304C1.23859 15.8516 1.80907 16.1263 2.33035 15.9439L1.66965 14.0561ZM22.3304 8.94386C22.8516 8.76141 23.1263 8.19093 22.9439 7.66965C22.7614 7.14837 22.1909 6.87369 21.6696 7.05614L22.3304 8.94386ZM2.33035 15.9439L22.3304 8.94386L21.6696 7.05614L1.66965 14.0561L2.33035 15.9439Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const StrongMagicIcon = (props: IconProps) => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <g>
      <path
        d="M11.017 2.81401C11.0598 2.58462 11.1815 2.37743 11.3611 2.22833C11.5406 2.07924 11.7666 1.99762 12 1.99762C12.2333 1.99762 12.4593 2.07924 12.6389 2.22833C12.8184 2.37743 12.9401 2.58462 12.983 2.81401L14.034 8.37201C14.1086 8.76716 14.3006 9.13063 14.585 9.41498C14.8693 9.69934 15.2328 9.89137 15.628 9.96601L21.186 11.017C21.4153 11.0599 21.6225 11.1816 21.7716 11.3611C21.9207 11.5406 22.0023 11.7667 22.0023 12C22.0023 12.2334 21.9207 12.4594 21.7716 12.6389C21.6225 12.8184 21.4153 12.9402 21.186 12.983L15.628 14.034C15.2328 14.1087 14.8693 14.3007 14.585 14.585C14.3006 14.8694 14.1086 15.2329 14.034 15.628L12.983 21.186C12.9401 21.4154 12.8184 21.6226 12.6389 21.7717C12.4593 21.9208 12.2333 22.0024 12 22.0024C11.7666 22.0024 11.5406 21.9208 11.3611 21.7717C11.1815 21.6226 11.0598 21.4154 11.017 21.186L9.96595 15.628C9.89131 15.2329 9.69928 14.8694 9.41492 14.585C9.13057 14.3007 8.7671 14.1087 8.37195 14.034L2.81395 12.983C2.58456 12.9402 2.37737 12.8184 2.22827 12.6389C2.07917 12.4594 1.99756 12.2334 1.99756 12C1.99756 11.7667 2.07917 11.5406 2.22827 11.3611C2.37737 11.1816 2.58456 11.0599 2.81395 11.017L8.37195 9.96601C8.7671 9.89137 9.13057 9.69934 9.41492 9.41498C9.69928 9.13063 9.89131 8.76716 9.96595 8.37201L11.017 2.81401Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 2V6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 4H18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 22C5.10457 22 6 21.1046 6 20C6 18.8954 5.10457 18 4 18C2.89543 18 2 18.8954 2 20C2 21.1046 2.89543 22 4 22Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="17.75"
        y="17.75"
        width="4.5"
        height="4.5"
        rx="1.25"
        stroke="currentColor"
        strokeWidth="1.5"
      />

      {/* clean rhombus (top-left) */}
      <path
        d="M4.5 2.5L6.5 4.5L4.5 6.5L2.5 4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const LinkIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M10 5.5L10.7514 4.75837C13.0959 2.41387 16.8971 2.41388 19.2416 4.75837C21.5861 7.10287 21.5861 10.9041 19.2416 13.2486L18.5 14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 18.5L13.2486 19.2416C10.9041 21.5861 7.10287 21.5861 4.75838 19.2416C2.41388 16.8971 2.41387 13.0959 4.75837 10.7514L5.5 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 14L14 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const AddToTeamIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M21 10C21 8.34315 19.6569 7 18 7H13.6056C12.6025 7 11.6658 6.4987 11.1094 5.6641L10.8906 5.3359C10.3342 4.5013 9.39751 4 8.39445 4H6C4.34315 4 3 5.34315 3 7V16C3 17.6569 4.34315 19 6 19H11M18 14V17M18 17V20M18 17H15M18 17H21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const AddToTeamSuccessIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M21 10C21 8.34315 19.6569 7 18 7H13.6056C12.6025 7 11.6658 6.4987 11.1094 5.6641L10.8906 5.3359C10.3342 4.5013 9.39751 4 8.39445 4H6C4.34315 4 3 5.34315 3 7V16C3 17.6569 4.34315 19 6 19H11M15 18.5L17 20L20 15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const BillingIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M3 10V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V10M3 10V7C3 5.89543 3.89543 5 5 5H19C20.1046 5 21 5.89518 21 6.99975V10M3 10H21M7 14H10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const PublisherStudioIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M8 4C8 3.44772 7.55228 3 7 3C6.44772 3 6 3.44772 6 4H8ZM6 10C6 10.5523 6.44772 11 7 11C7.55228 11 8 10.5523 8 10H6ZM4 6C3.44772 6 3 6.44772 3 7C3 7.55228 3.44772 8 4 8V6ZM10 8C10.5523 8 11 7.55228 11 7C11 6.44772 10.5523 6 10 6V8ZM19.8282 15.5853C20.2187 15.1947 20.2187 14.5616 19.8282 14.1711C19.4377 13.7805 18.8045 13.7805 18.414 14.1711L19.8282 15.5853ZM14.1713 18.4137C13.7808 18.8042 13.7808 19.4374 14.1713 19.8279C14.5619 20.2184 15.195 20.2184 15.5855 19.8279L14.1713 18.4137ZM15.5855 14.1711C15.195 13.7805 14.5619 13.7805 14.1713 14.1711C13.7808 14.5616 13.7808 15.1947 14.1713 15.5853L15.5855 14.1711ZM18.414 19.8279C18.8045 20.2184 19.4377 20.2184 19.8282 19.8279C20.2187 19.4374 20.2187 18.8042 19.8282 18.4137L18.414 19.8279ZM17 9C15.8954 9 15 8.10457 15 7H13C13 9.20914 14.7909 11 17 11V9ZM19 7C19 8.10457 18.1046 9 17 9V11C19.2091 11 21 9.20914 21 7H19ZM17 5C18.1046 5 19 5.89543 19 7H21C21 4.79086 19.2091 3 17 3V5ZM17 3C14.7909 3 13 4.79086 13 7H15C15 5.89543 15.8954 5 17 5V3ZM6 4V7H8V4H6ZM6 7V10H8V7H6ZM4 8H7V6H4V8ZM7 8H10V6H7V8ZM18.414 14.1711L16.2926 16.2924L17.7069 17.7066L19.8282 15.5853L18.414 14.1711ZM16.2926 16.2924L14.1713 18.4137L15.5855 19.8279L17.7069 17.7066L16.2926 16.2924ZM14.1713 15.5853L16.2926 17.7066L17.7069 16.2924L15.5855 14.1711L14.1713 15.5853ZM16.2926 17.7066L18.414 19.8279L19.8282 18.4137L17.7069 16.2924L16.2926 17.7066ZM5.5 15H8.5V13H5.5V15ZM9 15.5V18.5H11V15.5H9ZM8.5 19H5.5V21H8.5V19ZM5 18.5V15.5H3V18.5H5ZM5.5 19C5.22386 19 5 18.7761 5 18.5H3C3 19.8807 4.11929 21 5.5 21V19ZM9 18.5C9 18.7761 8.77614 19 8.5 19V21C9.88071 21 11 19.8807 11 18.5H9ZM8.5 15C8.77614 15 9 15.2239 9 15.5H11C11 14.1193 9.88071 13 8.5 13V15ZM5.5 13C4.11929 13 3 14.1193 3 15.5H5C5 15.2239 5.22386 15 5.5 15V13Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const ClaudeCodeIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M5.92405 15.2962L9.85823 13.0903L9.92405 12.8981L9.85823 12.7918H9.66582L9.0076 12.7513L6.75949 12.6906L4.81013 12.6097L2.92152 12.5085L2.44557 12.4073L2 11.8204L2.04557 11.5269L2.44557 11.2588L3.01772 11.3094L4.28354 11.3954L6.18228 11.5269L7.55949 11.6079L9.6 11.8204H9.92405L9.96962 11.6888L9.85823 11.6079L9.77215 11.5269L7.8076 10.1963L5.68101 8.78978L4.56709 7.98027L3.96456 7.57045L3.66076 7.18594L3.52911 6.34607L4.07595 5.74399L4.81013 5.79459L4.99747 5.84518L5.74177 6.4169L7.33165 7.64635L9.4076 9.1743L9.71139 9.42727L9.83291 9.34126L9.8481 9.28055L9.71139 9.05287L8.58228 7.01391L7.37722 4.93954L6.84051 4.07943L6.69873 3.56337C6.6481 3.35087 6.61266 3.17379 6.61266 2.95624L7.23544 2.11131L7.57975 2L8.41013 2.11131L8.75949 2.41487L9.27595 3.59373L10.1114 5.45054L11.4076 7.97521L11.7873 8.72401L11.9899 9.41715L12.0658 9.62965H12.1975V9.50822L12.3038 8.08652L12.5013 6.34101L12.6937 4.09461L12.7595 3.46218L13.0734 2.70326L13.6962 2.29345L14.1823 2.52618L14.5823 3.0979L14.5266 3.46724L14.2886 5.01037L13.8228 7.42879L13.519 9.04781H13.6962L13.8987 8.84543L14.719 7.75765L16.0962 6.03744L16.7038 5.35441L17.4127 4.60056L17.8684 4.24134H18.7291L19.362 5.18239L19.0785 6.15381L18.1924 7.27701L17.4582 8.22818L16.4051 9.64483L15.7468 10.7781L15.8076 10.8692L15.9646 10.854L18.3443 10.3481L19.6304 10.1154L21.1646 9.85226L21.8582 10.1761L21.9342 10.5049L21.6608 11.1778L20.0203 11.5826L18.0962 11.9671L15.2304 12.6451L15.1949 12.6704L15.2354 12.721L16.5266 12.8424L17.0785 12.8728H18.4304L20.9468 13.06L21.6051 13.4951L22 14.0263L21.9342 14.4311L20.9215 14.9471L19.5544 14.6233L16.3646 13.8644L15.2709 13.5912H15.119V13.6823L16.0304 14.5727L17.7013 16.0804L19.7924 18.0233L19.8987 18.5039L19.6304 18.8834L19.3468 18.8429L17.5089 17.4617L16.8 16.8394L15.1949 15.4885H15.0886V15.6302L15.4582 16.1715L17.4127 19.106L17.5139 20.0066L17.3722 20.3L16.8658 20.4771L16.3089 20.3759L15.1646 18.7721L13.9848 16.9658L13.0329 15.3468L12.9165 15.4126L12.3544 21.4586L12.0911 21.7673L11.4835 22L10.9772 21.6155L10.7089 20.9932L10.9772 19.7637L11.3013 18.1599L11.5646 16.8849L11.8025 15.3013L11.9443 14.7751L11.9342 14.7397L11.8177 14.7549L10.6228 16.3941L8.80506 18.848L7.36709 20.386L7.02279 20.5226L6.42532 20.214L6.48101 19.6625L6.81519 19.1718L8.80506 16.642L10.0051 15.0736L10.7797 14.168L10.7747 14.0364H10.7291L5.44304 17.4667L4.50127 17.5882L4.0962 17.2087L4.14684 16.5864L4.33924 16.384L5.92911 15.2912L5.92405 15.2962Z"
      fill="currentColor"
    />
  </svg>
)

export const CursorIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11.9976 22.5L3.10938 17.25V6.75L11.9976 12V22.5Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M11.9976 6.75H3.10938L11.9976 1.5L20.885 6.74907L11.9976 6.75Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M20.8869 17.25L11.9976 22.5L16.4432 14.625L20.885 6.74907L20.8869 17.25Z"
      fill="currentColor"
    />
  </svg>
)

export const GitHubLogo = (props: IconProps) => (
  <svg
    fill="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    {...props}
  >
    <path d="M12 2A10 10 0 0 0 2 12a10 10 0 0 0 6.838 9.488c.5.087.687-.213.687-.476 0-.237-.013-1.024-.013-1.862-2.512.463-3.162-.612-3.362-1.175-.113-.288-.6-1.175-1.025-1.413-.35-.187-.85-.65-.013-.662.788-.013 1.35.725 1.538 1.025.9 1.512 2.338 1.087 2.912.825.088-.65.35-1.087.638-1.337-2.225-.25-4.55-1.113-4.55-4.938 0-1.088.387-1.987 1.025-2.688-.1-.25-.45-1.275.1-2.65 0 0 .837-.262 2.75 1.026a9.28 9.28 0 0 1 2.5-.338c.85 0 1.7.112 2.5.337 1.912-1.3 2.75-1.025 2.75-1.025.55 1.375.2 2.4.1 2.65.637.7 1.025 1.587 1.025 2.687 0 3.838-2.337 4.688-4.562 4.938.362.312.675.912.675 1.85 0 1.337-.013 2.412-.013 2.75 0 .262.188.574.688.474A10.016 10.016 0 0 0 22 12 10 10 0 0 0 12 2Z" />
  </svg>
)

export const WindsurfIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M22.5893 5.64345H22.7989L22.798 5.64259C22.9098 5.64259 23 5.73282 23 5.84454V10.0837C23 10.1954 22.9098 10.2856 22.798 10.2856H22.6202C21.729 10.2856 21.0072 11.0075 21.0072 11.8986V16.3861C21.0072 17.4757 20.0972 18.36 19.035 18.36C18.339 18.36 17.7554 18.0386 17.3765 17.4972L12.8185 10.9886C12.5101 10.5486 12.0065 10.2865 11.4694 10.2865H11.4668C10.5757 10.2865 9.85381 11.0083 9.85381 11.8995V16.3852C9.85381 17.6236 8.69198 18.5955 7.42961 18.3084C6.92517 18.1941 6.48776 17.8796 6.19129 17.456L1.17273 10.2882C1.06015 10.1266 1 9.93587 1 9.73908V5.84712C1 5.64603 1.25867 5.56525 1.37381 5.72939L6.47402 13.0132C6.78252 13.4532 7.30156 13.7153 7.82404 13.7153C8.70658 13.7153 9.43703 12.9934 9.43703 12.1023V7.61393C9.43703 6.52342 10.372 5.64001 11.411 5.64001C12.077 5.64001 12.6922 5.96227 13.0703 6.5028L17.6283 13.0123C17.9368 13.4523 18.4567 13.7144 18.9774 13.7144C19.854 13.7144 20.5905 12.9925 20.5905 12.1014V7.63884C20.5905 6.53545 21.4859 5.64173 22.5893 5.64345Z"
      fill="currentColor"
    />
  </svg>
)

export const OriginalMCPIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M15.0915 3.8956C14.6865 3.50142 14.1437 3.28087 13.5785 3.28087C13.0133 3.28087 12.4705 3.50142 12.0655 3.8956L3.9966 11.8086C3.86157 11.9398 3.6807 12.0132 3.4924 12.0132C3.3041 12.0132 3.12322 11.9398 2.9882 11.8086C2.92209 11.7443 2.86955 11.6674 2.83366 11.5824C2.79778 11.4975 2.7793 11.4062 2.7793 11.314C2.7793 11.2218 2.79778 11.1305 2.83366 11.0456C2.86955 10.9606 2.92209 10.8837 2.9882 10.8194L11.0571 2.90647C11.732 2.24962 12.6367 1.8821 13.5785 1.8821C14.5203 1.8821 15.425 2.24962 16.0999 2.90647C16.4905 3.28628 16.7855 3.75318 16.961 4.26894C17.1364 4.7847 17.1872 5.33467 17.1092 5.87384C17.6555 5.79614 18.2124 5.84491 18.7369 6.0164C19.2614 6.18789 19.7395 6.47752 20.1344 6.86296L20.1763 6.90487C20.5068 7.22632 20.7695 7.61077 20.949 8.0355C21.1284 8.46023 21.2208 8.91661 21.2208 9.37768C21.2208 9.83874 21.1284 10.2951 20.949 10.7199C20.7695 11.1446 20.5068 11.529 20.1763 11.8505L12.8786 19.0065C12.8565 19.0279 12.839 19.0535 12.8271 19.0818C12.8151 19.1101 12.809 19.1405 12.809 19.1712C12.809 19.202 12.8151 19.2324 12.8271 19.2606C12.839 19.2889 12.8565 19.3145 12.8786 19.336L14.3773 20.8062C14.4435 20.8705 14.496 20.9474 14.5319 21.0323C14.5678 21.1173 14.5862 21.2086 14.5862 21.3008C14.5862 21.393 14.5678 21.4843 14.5319 21.5692C14.496 21.6542 14.4435 21.7311 14.3773 21.7953C14.2423 21.9266 14.0614 22 13.8731 22C13.6848 22 13.504 21.9266 13.3689 21.7953L11.8702 20.3259C11.7158 20.1759 11.5931 19.9965 11.5093 19.7982C11.4255 19.6 11.3823 19.3869 11.3823 19.1717C11.3823 18.9564 11.4255 18.7434 11.5093 18.5451C11.5931 18.3468 11.7158 18.1674 11.8702 18.0174L19.1679 10.8605C19.3661 10.6676 19.5236 10.4369 19.6312 10.1821C19.7388 9.92724 19.7942 9.65344 19.7942 9.37684C19.7942 9.10023 19.7388 8.82643 19.6312 8.5716C19.5236 8.31677 19.3661 8.08608 19.1679 7.89316L19.126 7.85208C18.7214 7.45833 18.1793 7.23779 17.6147 7.23732C17.0502 7.23685 16.5077 7.45648 16.1024 7.84957L10.0906 13.7457L10.0889 13.7474L10.0068 13.8287C9.87171 13.9602 9.69065 14.0338 9.50215 14.0338C9.31365 14.0338 9.1326 13.9602 8.99753 13.8287C8.93142 13.7644 8.87888 13.6875 8.843 13.6026C8.80712 13.5177 8.78863 13.4264 8.78863 13.3342C8.78863 13.2419 8.80712 13.1507 8.843 13.0657C8.87888 12.9808 8.93142 12.9039 8.99753 12.8396L15.094 6.86045C15.2917 6.66739 15.4487 6.43672 15.5559 6.18203C15.663 5.92735 15.7181 5.65379 15.7178 5.37749C15.7176 5.10119 15.6621 4.82773 15.5545 4.57322C15.4469 4.31872 15.2895 4.08832 15.0915 3.8956Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.0817 5.87383C14.1478 5.80954 14.2004 5.73265 14.2362 5.64771C14.2721 5.56276 14.2906 5.47148 14.2906 5.37927C14.2906 5.28706 14.2721 5.19578 14.2362 5.11084C14.2004 5.02589 14.1478 4.949 14.0817 4.88471C13.9467 4.75322 13.7656 4.67964 13.5771 4.67964C13.3886 4.67964 13.2075 4.75322 13.0725 4.88471L7.10506 10.7373C6.77452 11.0587 6.51179 11.4432 6.33239 11.8679C6.15298 12.2926 6.06055 12.749 6.06055 13.2101C6.06055 13.6712 6.15298 14.1275 6.33239 14.5523C6.51179 14.977 6.77452 15.3615 7.10506 15.6829C7.78012 16.3396 8.68472 16.7069 9.62648 16.7069C10.5682 16.7069 11.4728 16.3396 12.1479 15.6829L18.1162 9.83032C18.1823 9.76603 18.2348 9.68914 18.2707 9.60419C18.3066 9.51925 18.3251 9.42797 18.3251 9.33576C18.3251 9.24355 18.3066 9.15227 18.2707 9.06732C18.2348 8.98238 18.1823 8.90549 18.1162 8.8412C17.9811 8.70971 17.8 8.63613 17.6115 8.63613C17.423 8.63613 17.242 8.70971 17.1069 8.8412L11.1395 14.6938C10.7345 15.088 10.1916 15.3085 9.62648 15.3085C9.06132 15.3085 8.51847 15.088 8.11346 14.6938C7.91524 14.5009 7.75769 14.2702 7.65012 14.0153C7.54254 13.7605 7.48712 13.4867 7.48712 13.2101C7.48712 12.9335 7.54254 12.6597 7.65012 12.4049C7.75769 12.15 7.91524 11.9193 8.11346 11.7264L14.0817 5.87383Z"
      fill="currentColor"
    />
  </svg>
)

export const ShadcnCLIIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M15 21L21 15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M7 21L21 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </g>
  </svg>
)

export const VSCodeIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M15.7735 20.9229C15.9175 20.9791 16.0714 21.005 16.2258 20.9991C16.3802 20.9932 16.5317 20.9555 16.671 20.8886L20.3962 19.0961C20.5881 19.0037 20.75 18.8591 20.8633 18.6788C20.9766 18.4985 21.0367 18.2898 21.0367 18.0769V5.92301C21.0367 5.71008 20.9765 5.50148 20.8632 5.32121C20.7499 5.14094 20.588 4.99632 20.3962 4.904L16.6711 3.11151C16.4606 3.01023 16.2239 2.97689 15.9936 3.01612C15.7633 3.05534 15.5509 3.16518 15.3858 3.33044L8.25458 9.83601L5.14836 7.47847C5.00826 7.37212 4.83535 7.31816 4.65963 7.32596C4.48391 7.33376 4.31647 7.40282 4.18634 7.52117L3.18996 8.42746C3.11234 8.49808 3.05032 8.58412 3.00786 8.68008C2.9654 8.77604 2.94343 8.87981 2.94336 8.98475C2.94329 9.08968 2.96512 9.19348 3.00746 9.28949C3.0498 9.38551 3.11171 9.47163 3.18923 9.54235L5.88294 11.9999L3.18923 14.4575C3.11171 14.5283 3.0498 14.6144 3.00746 14.7104C2.96512 14.8064 2.94329 14.9102 2.94336 15.0151C2.94343 15.1201 2.9654 15.2238 3.00786 15.3198C3.05032 15.4158 3.11234 15.5018 3.18996 15.5724L4.18634 16.4787C4.31647 16.5971 4.48391 16.6661 4.65963 16.6739C4.83535 16.6817 5.00826 16.6278 5.14836 16.5214L8.25458 14.1639L15.3858 20.6698C15.4961 20.7802 15.6281 20.8663 15.7735 20.9229ZM16.5159 7.8928L11.105 11.9999L16.5159 16.1073V7.8928Z"
      fill="currentColor"
    />
  </svg>
)

export const ThreeSparklesIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13 7C13.5523 7 14 7.44772 14 8C14 10.3085 14.5108 11.7424 15.3842 12.6158C16.2576 13.4892 17.6915 14 20 14C20.5523 14 21 14.4477 21 15C21 15.5523 20.5523 16 20 16C17.6915 16 16.2576 16.5108 15.3842 17.3842C14.5108 18.2576 14 19.6915 14 22C14 22.5523 13.5523 23 13 23C12.4477 23 12 22.5523 12 22C12 19.6915 11.4892 18.2576 10.6158 17.3842C9.74243 16.5108 8.30849 16 6 16C5.44772 16 5 15.5523 5 15C5 14.4477 5.44772 14 6 14C8.30849 14 9.74243 13.4892 10.6158 12.6158C11.4892 11.7424 12 10.3085 12 8C12 7.44772 12.4477 7 13 7ZM13 12.7334C12.7361 13.212 12.4147 13.6453 12.03 14.03C11.6453 14.4147 11.212 14.7361 10.7334 15C11.212 15.2639 11.6453 15.5853 12.03 15.97C12.4147 16.3547 12.7361 16.788 13 17.2666C13.2639 16.788 13.5853 16.3547 13.97 15.97C14.3547 15.5853 14.788 15.2639 15.2666 15C14.788 14.7361 14.3547 14.4147 13.97 14.03C13.5853 13.6453 13.2639 13.212 13 12.7334Z"
      fill="currentColor"
    />
    <path
      d="M6 5.5C6 5.22386 5.77614 5 5.5 5C5.22386 5 5 5.22386 5 5.5C5 6.48063 4.78279 7.0726 4.4277 7.4277C4.0726 7.78279 3.48063 8 2.5 8C2.22386 8 2 8.22386 2 8.5C2 8.77614 2.22386 9 2.5 9C3.48063 9 4.0726 9.21721 4.4277 9.5723C4.78279 9.9274 5 10.5194 5 11.5C5 11.7761 5.22386 12 5.5 12C5.77614 12 6 11.7761 6 11.5C6 10.5194 6.21721 9.9274 6.5723 9.5723C6.9274 9.21721 7.51937 9 8.5 9C8.77614 9 9 8.77614 9 8.5C9 8.22386 8.77614 8 8.5 8C7.51937 8 6.9274 7.78279 6.5723 7.4277C6.21721 7.0726 6 6.48063 6 5.5Z"
      fill="currentColor"
    />
    <path
      d="M11 1.5C11 1.22386 10.7761 1 10.5 1C10.2239 1 10 1.22386 10 1.5C10 2.13341 9.85918 2.47538 9.66728 2.66728C9.47538 2.85918 9.13341 3 8.5 3C8.22386 3 8 3.22386 8 3.5C8 3.77614 8.22386 4 8.5 4C9.13341 4 9.47538 4.14082 9.66728 4.33272C9.85918 4.52462 10 4.86659 10 5.5C10 5.77614 10.2239 6 10.5 6C10.7761 6 11 5.77614 11 5.5C11 4.86659 11.1408 4.52462 11.3327 4.33272C11.5246 4.14082 11.8666 4 12.5 4C12.7761 4 13 3.77614 13 3.5C13 3.22386 12.7761 3 12.5 3C11.8666 3 11.5246 2.85918 11.3327 2.66728C11.1408 2.47538 11 2.13341 11 1.5Z"
      fill="currentColor"
    />
  </svg>
)

// Filled versions for settings dialog
export const PromptCopyIconFilled = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.1865 3C14.7642 3.36673 14.4994 3.90569 14.5 4.50195L14.5088 4.68945C14.5967 5.61565 15.3225 6.36881 16.2637 6.47559L16.4463 6.50195C16.8463 6.57317 17.0679 6.70844 17.1924 6.83008C17.3262 6.96094 17.4762 7.20083 17.5195 7.68848L17.5459 7.87793C17.7195 8.8099 18.5361 9.50095 19.502 9.5L19.6934 9.49023C20.212 9.44001 20.6741 9.18919 21 8.81445V18C21 19.6569 19.6569 21 18 21H6C4.34315 21 3 19.6569 3 18V6C3 4.34315 4.34315 3 6 3H15.1865ZM8 15.0996C7.50294 15.0996 7.09961 15.5029 7.09961 16C7.09961 16.4971 7.50294 16.9004 8 16.9004H13L13.0918 16.8955C13.5457 16.8495 13.9004 16.4661 13.9004 16C13.9004 15.5339 13.5457 15.1505 13.0918 15.1045L13 15.0996H8ZM8 11.0996C7.50294 11.0996 7.09961 11.5029 7.09961 12C7.09961 12.4971 7.50294 12.9004 8 12.9004H10L10.0918 12.8955C10.5457 12.8495 10.9004 12.4661 10.9004 12C10.9004 11.5339 10.5457 11.1505 10.0918 11.1045L10 11.0996H8ZM13 11.0996C12.5029 11.0996 12.0996 11.5029 12.0996 12C12.0996 12.4971 12.5029 12.9004 13 12.9004H16L16.0918 12.8955C16.5457 12.8495 16.9004 12.4661 16.9004 12C16.9004 11.5339 16.5457 11.1505 16.0918 11.1045L16 11.0996H13ZM8 7.09961C7.50294 7.09961 7.09961 7.50294 7.09961 8C7.09961 8.49706 7.50294 8.90039 8 8.90039H12L12.0918 8.89551C12.5457 8.84953 12.9004 8.46607 12.9004 8C12.9004 7.53393 12.5457 7.15047 12.0918 7.10449L12 7.09961H8Z"
        fill="currentColor"
      />
      <path
        d="M19.9847 1.4329C19.9568 1.18651 19.7485 1.00025 19.5005 1C19.2525 0.999747 19.0438 1.18557 19.0154 1.43191C18.838 2.96993 17.9699 3.83801 16.4319 4.01541C16.1856 4.04382 15.9997 4.25253 16 4.5005C16.0003 4.74847 16.1865 4.9568 16.4329 4.9847C17.9491 5.15645 18.8774 6.01617 19.0141 7.55536C19.0365 7.80725 19.2477 8.00028 19.5005 8C19.7534 7.99971 19.9642 7.80621 19.986 7.55426C20.1173 6.03683 21.0368 5.11734 22.5543 4.98599C22.8062 4.96418 22.9997 4.75344 23 4.50055C23.0003 4.24766 22.8073 4.03648 22.5554 4.01411C21.0162 3.87738 20.1564 2.94911 19.9847 1.4329Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const ProfileIconFilled = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22ZM15 10C15 11.6569 13.6569 13 12 13C10.3431 13 9 11.6569 9 10C9 8.34315 10.3431 7 12 7C13.6569 7 15 8.34315 15 10ZM12.0002 20C9.76181 20 7.73814 19.0807 6.28613 17.5991C7.61787 16.005 9.60491 15 12.0002 15C14.3955 15 16.3825 16.005 17.7143 17.5991C16.2623 19.0807 14.2386 20 12.0002 20Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const SandboxIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    width="24"
    height="24"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 6C3 4.34315 4.34315 3 6 3H18C19.6569 3 21 4.34315 21 6V18C21 19.6569 19.6569 21 18 21H6C4.34315 21 3 19.6569 3 18V6ZM10.7071 8.79289C11.0976 9.18342 11.0976 9.81658 10.7071 10.2071L8.91421 12L10.7071 13.7929C11.0976 14.1834 11.0976 14.8166 10.7071 15.2071C10.3166 15.5976 9.68342 15.5976 9.29289 15.2071L7.5 13.4142C6.71895 12.6332 6.71895 11.3668 7.5 10.5858L9.29289 8.79289C9.68342 8.40237 10.3166 8.40237 10.7071 8.79289ZM14.7071 8.79289C14.3166 8.40237 13.6834 8.40237 13.2929 8.79289C12.9024 9.18342 12.9024 9.81658 13.2929 10.2071L15.0858 12L13.2929 13.7929C12.9024 14.1834 12.9024 14.8166 13.2929 15.2071C13.6834 15.5976 14.3166 15.5976 14.7071 15.2071L16.5 13.4142C17.281 12.6332 17.281 11.3668 16.5 10.5858L14.7071 8.79289Z"
      fill="currentColor"
    />
  </svg>
)

export const EyeOpenFilledIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    width="24"
    height="24"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 4C15.9517 3.99997 19.7906 6.27233 22.3567 10.5831C22.8762 11.4558 22.8762 12.5441 22.3567 13.4168C19.7906 17.7276 15.9517 20 12 20C8.04829 20 4.20943 17.7277 1.64329 13.4169C1.12379 12.5442 1.12379 11.4559 1.64329 10.5832C4.20943 6.27243 8.04828 4.00003 12 4ZM8.5 12C8.5 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.5 13.933 8.5 12Z"
      fill="currentColor"
    />
  </svg>
)

export const BillingIconFilled = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M5 4C3.34315 4 2 5.34315 2 7V9H22V6.99975C22 5.34274 20.6567 4 19 4H5Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2 17V11H22V17C22 18.6569 20.6569 20 19 20H5C3.34315 20 2 18.6569 2 17ZM7 13C6.44772 13 6 13.4477 6 14C6 14.5523 6.44772 15 7 15H10C10.5523 15 11 14.5523 11 14C11 13.4477 10.5523 13 10 13H7Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const RemixIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M3 18H4.17157C4.70201 18 5.21071 17.7893 5.58579 17.4142L15.4142 7.58579C15.7893 7.21071 16.298 7 16.8284 7H19M3 6H4.17157C4.70201 6 5.21071 6.21071 5.58579 6.58579L8 9M19 17H16.8284C16.298 17 15.7893 16.7893 15.4142 16.4142L14 15M18 4L21 7L18 10M18 14L21 17L18 20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

// Small circular info icon used in Code/Info tabs
export const InfoCircleSmallIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M11 11H12V16M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 7.25C11.5858 7.25 11.25 7.58579 11.25 8C11.25 8.41421 11.5858 8.75 12 8.75C12.4142 8.75 12.75 8.41421 12.75 8C12.75 7.58579 12.4142 7.25 12 7.25Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="0.5"
    />
  </svg>
)

export const MailIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M12.8944 12.5528L13.3416 13.4472L12.8944 12.5528ZM20 7V17H22V7H20ZM19 18H5.00002V20H19V18ZM4.00002 17V7H2.00002V17H4.00002ZM5.00002 6H19V4H5.00002V6ZM20.5528 7.60557L12.4472 11.6584L13.3416 13.4472L21.4472 9.39443L20.5528 7.60557ZM11.5528 11.6584L3.44723 7.60557L2.5528 9.39443L10.6584 13.4472L11.5528 11.6584ZM4.00002 7C4.00002 6.44772 4.44773 6 5.00002 6V4C3.34316 4 2.00002 5.34314 2.00002 7H4.00002ZM5.00002 18C4.44773 18 4.00002 17.5523 4.00002 17H2.00002C2.00002 18.6569 3.34316 20 5.00002 20V18ZM20 17C20 17.5523 19.5523 18 19 18V20C20.6569 20 22 18.6569 22 17H20ZM12.4472 11.6584C12.1657 11.7991 11.8343 11.7991 11.5528 11.6584L10.6584 13.4472C11.5029 13.8695 12.4971 13.8695 13.3416 13.4472L12.4472 11.6584ZM22 7C22 5.34315 20.6569 4 19 4V6C19.5523 6 20 6.44772 20 7H22Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const EmailNotificationIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.1) translate(-1.8, -1.8)">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M20 2C17.7909 2 16 3.79086 16 6C16 8.20914 17.7909 10 20 10C22.2091 10 24 8.20914 24 6C24 3.79086 22.2091 2 20 2ZM18 6C18 4.89543 18.8954 4 20 4C21.1046 4 22 4.89543 22 6C22 7.10457 21.1046 8 20 8C18.8954 8 18 7.10457 18 6Z"
        fill="currentColor"
      />
      <path
        d="M20 12C19.3875 12 18.7964 11.9082 18.2397 11.7376C16.3224 12.5504 14.2137 13 12 13C8.21621 13 4.7392 11.6866 2 9.49074V17C2 18.6569 3.34315 20 5 20H19C20.6569 20 22 18.6569 22 17V11.6586C21.3744 11.8797 20.7013 12 20 12Z"
        fill="currentColor"
      />
      <path
        d="M14 6C14 5.29873 14.1203 4.62556 14.3414 4H5C3.40887 4 2.10706 5.2387 2.00628 6.80437C4.54686 9.39371 8.08585 11 12 11C13.3741 11 14.702 10.802 15.9567 10.4331C14.7544 9.33581 14 7.756 14 6Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const AffiliateIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M12.0017 6V4M8.14886 7.40371L6.86328 5.87162M15.864 7.40367L17.1496 5.87158M2 19.0001H7.35165C8.86462 19.0001 10.1408 17.8735 10.3285 16.3722L10.5785 14.3722C10.8023 12.5817 9.40615 11.0001 7.60165 11.0001H7.5L6.79566 10.5305C6.2889 10.1927 5.66315 10.0843 5.07229 10.232C4.39889 10.4004 3.8473 10.8819 3.58951 11.5263L3 13.0001H2M22.0005 19.0001H16.6489C15.1359 19.0001 13.8597 17.8735 13.672 16.3722L13.422 14.3722C13.1982 12.5817 14.5944 11.0001 16.3989 11.0001H16.5005L17.2049 10.5305C17.7116 10.1927 18.3374 10.0843 18.9282 10.232C19.6016 10.4004 20.1532 10.8819 20.411 11.5263L21.0005 13.0001H22.0005"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const ReportIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M5 15V4C5 3.44772 5.44772 3 6 3H19.1315C19.9302 3 20.4066 3.89015 19.9635 4.5547L17.3698 8.4453C17.1459 8.7812 17.1459 9.2188 17.3698 9.5547L19.9635 13.4453C20.4066 14.1099 19.9302 15 19.1315 15H5ZM5 15V21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const ThinFolderIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M20.5 11V8.5C20.5 7.39543 19.6046 6.5 18.5 6.5H12.5352C12.2008 6.5 11.8886 6.3329 11.7031 6.0547L10.5937 4.3906C10.2228 3.8342 9.59834 3.5 8.92963 3.5H4.5C3.39543 3.5 2.5 4.39543 2.5 5.5V17.784C2.5 18.7317 3.26829 19.5 4.21601 19.5M20.5 11H9.49648C8.60926 11 7.82809 11.5845 7.57774 12.4357L5.8623 18.2682C5.6475 18.9985 4.97725 19.5 4.21601 19.5M20.5 11H20.9135C21.5811 11 22.0613 11.6417 21.8729 12.2822L20.1723 18.0643C19.9219 18.9155 19.1407 19.5 18.2535 19.5H4.21601"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const ThresholdIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M11.9986 13L8.99864 10M5.29147 19C2.12534 15.4663 2.2402 10.0319 5.63604 6.63604C9.15076 3.12132 14.8492 3.12132 18.364 6.63604C21.7598 10.0319 21.8747 15.4663 18.7085 19"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const SlackIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    width="16"
    height="16"
    {...props}
  >
    <path
      d="M6.36125 14.5772C6.36125 15.7106 5.44597 16.6266 4.3135 16.6266C3.18104 16.6266 2.26576 15.7106 2.26576 14.5772C2.26576 13.4439 3.18104 12.5279 4.3135 12.5279H6.36125V14.5772ZM7.38512 14.5772C7.38512 13.4439 8.3004 12.5279 9.43286 12.5279C10.5653 12.5279 11.4806 13.4439 11.4806 14.5772V19.7006C11.4806 20.834 10.5653 21.75 9.43286 21.75C8.3004 21.75 7.38512 20.834 7.38512 19.7006V14.5772Z"
      fill="currentColor"
    />
    <path
      d="M9.43262 6.34872C8.30016 6.34872 7.38488 5.43272 7.38488 4.29936C7.38488 3.166 8.30016 2.25 9.43262 2.25C10.5651 2.25 11.4804 3.166 11.4804 4.29936V6.34872H9.43262ZM9.43262 7.38893C10.5651 7.38893 11.4804 8.30493 11.4804 9.43829C11.4804 10.5717 10.5651 11.4877 9.43262 11.4877H4.29775C3.16528 11.4877 2.25 10.5717 2.25 9.43829C2.25 8.30493 3.16528 7.38893 4.29775 7.38893H9.43262Z"
      fill="currentColor"
    />
    <path
      d="M17.639 9.43829C17.639 8.30493 18.5543 7.38893 19.6867 7.38893C20.8192 7.38893 21.7345 8.30493 21.7345 9.43829C21.7345 10.5717 20.8192 11.4877 19.6867 11.4877H17.639V9.43829ZM16.6151 9.43829C16.6151 10.5717 15.6998 11.4877 14.5674 11.4877C13.4349 11.4877 12.5196 10.5717 12.5196 9.43829V4.29936C12.5196 3.166 13.4349 2.25 14.5674 2.25C15.6998 2.25 16.6151 3.166 16.6151 4.29936V9.43829Z"
      fill="currentColor"
    />
    <path
      d="M14.5674 17.6513C15.6998 17.6513 16.6151 18.5673 16.6151 19.7006C16.6151 20.834 15.6998 21.75 14.5674 21.75C13.4349 21.75 12.5196 20.834 12.5196 19.7006V17.6513H14.5674ZM14.5674 16.6266C13.4349 16.6266 12.5196 15.7106 12.5196 14.5772C12.5196 13.4439 13.4349 12.5279 14.5674 12.5279H19.7023C20.8347 12.5279 21.75 13.4439 21.75 14.5772C21.75 15.7106 20.8347 16.6266 19.7023 16.6266H14.5674Z"
      fill="currentColor"
    />
  </svg>
)

export const CategoriesIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M4 6C4 4.89543 4.89543 4 6 4H8C9.10457 4 10 4.89543 10 6V8C10 9.10457 9.10457 10 8 10H6C4.89543 10 4 9.10457 4 8V6Z"
      stroke="currentColor"
      strokeWidth="1.995"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4 16C4 14.8954 4.89543 14 6 14H8C9.10457 14 10 14.8954 10 16V18C10 19.1046 9.10457 20 8 20H6C4.89543 20 4 19.1046 4 18V16Z"
      stroke="currentColor"
      strokeWidth="1.995"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 6C14 4.89543 14.8954 4 16 4H18C19.1046 4 20 4.89543 20 6V8C20 9.10457 19.1046 10 18 10H16C14.8954 10 14 9.10457 14 8V6Z"
      stroke="currentColor"
      strokeWidth="1.995"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 17C14 15.3431 15.3431 14 17 14C18.6569 14 20 15.3431 20 17C20 18.6569 18.6569 20 17 20C15.3431 20 14 18.6569 14 17Z"
      stroke="currentColor"
      strokeWidth="1.995"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const ListSearchIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <g transform="scale(1.2) translate(-1.8, -1.8)">
      <path
        d="M4 5C3.44772 5 3 5.44772 3 6C3 6.55228 3.44772 7 4 7H20C20.5523 7 21 6.55228 21 6C21 5.44772 20.5523 5 20 5H4Z"
        fill="currentColor"
      />
      <path
        d="M4 11C3.36882 11 3 11.4477 3 12C3 12.5523 3.36882 13 4 13H10C10.6312 13 11 12.5523 11 12C11 11.4477 10.6586 11 10.0274 11H4Z"
        fill="currentColor"
      />
      <path
        d="M4 17C3.5 17 3 17.4477 3 18C3 18.5523 3.5 19 4 19H11C11.5 19 12 18.5523 12 18C12 17.4477 11.5 17 11 17H4Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M19.8284 11.1722C18.2663 9.61009 15.7337 9.61009 14.1716 11.1722C12.6095 12.7343 12.6095 15.2669 14.1716 16.829C15.4895 18.147 17.4983 18.353 19.0322 17.447L20.2929 18.7077C20.6834 19.0982 21.3166 19.0982 21.7071 18.7077C22.0976 18.3172 22.0976 17.684 21.7071 17.2935L20.4464 16.0328C21.3524 14.4989 21.1464 12.4901 19.8284 11.1722ZM15.5858 12.5864C16.3668 11.8053 17.6332 11.8053 18.4142 12.5864C19.1953 13.3674 19.1953 14.6338 18.4142 15.4148C17.6332 16.1959 16.3668 16.1959 15.5858 15.4148C14.8047 14.6338 14.8047 13.3674 15.5858 12.5864Z"
        fill="currentColor"
      />
    </g>
  </svg>
)

export const CloseCircleFilledIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM9.70711 8.29289C9.31658 7.90237 8.68342 7.90237 8.29289 8.29289C7.90237 8.68342 7.90237 9.31658 8.29289 9.70711L10.5858 12L8.29289 14.2929C7.90237 14.6834 7.90237 15.3166 8.29289 15.7071C8.68342 16.0976 9.31658 16.0976 9.70711 15.7071L12 13.4142L14.2929 15.7071C14.6834 16.0976 15.3166 16.0976 15.7071 15.7071C16.0976 15.3166 16.0976 14.6834 15.7071 14.2929L13.4142 12L15.7071 9.70711C16.0976 9.31658 16.0976 8.68342 15.7071 8.29289C15.3166 7.90237 14.6834 7.90237 14.2929 8.29289L12 10.5858L9.70711 8.29289Z"
      fill="currentColor"
    />
  </svg>
)

export const LayerUpIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M12 4L12 20M12 4L6 10M12 4L18 10"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const LayerDownIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M12 20L12 4M12 20L6 14M12 20L18 14"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
export const ExploreIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M17.2929 3.29289C17.6834 2.90237 18.3166 2.90237 18.7071 3.29289L20.7071 5.29289C21.0976 5.68342 21.0976 6.31658 20.7071 6.70711L18.7071 8.70711C18.3166 9.09763 17.6834 9.09763 17.2929 8.70711C16.9024 8.31658 16.9024 7.68342 17.2929 7.29289L17.5858 7H14C13.4477 7 13 7.44772 13 8V16C13 17.6569 11.6569 19 10 19H8.82929C8.41746 20.1652 7.30622 21 6 21C4.34315 21 3 19.6569 3 18C3 16.3431 4.34315 15 6 15C7.30622 15 8.41746 15.8348 8.82929 17H10C10.5523 17 11 16.5523 11 16V8C11 6.34315 12.3431 5 14 5H17.5858L17.2929 4.70711C16.9024 4.31658 16.9024 3.68342 17.2929 3.29289ZM3.54289 3.54289C3.93342 3.15237 4.56658 3.15237 4.95711 3.54289L6 4.58579L7.04289 3.54289C7.43342 3.15237 8.06658 3.15237 8.45711 3.54289C8.84763 3.93342 8.84763 4.56658 8.45711 4.95711L7.41421 6L8.45711 7.04289C8.84763 7.43342 8.84763 8.06658 8.45711 8.45711C8.06658 8.84763 7.43342 8.84763 7.04289 8.45711L6 7.41421L4.95711 8.45711C4.56658 8.84763 3.93342 8.84763 3.54289 8.45711C3.15237 8.06658 3.15237 7.43342 3.54289 7.04289L4.58579 6L3.54289 4.95711C3.15237 4.56658 3.15237 3.93342 3.54289 3.54289ZM15.5429 15.5429C15.9334 15.1524 16.5666 15.1524 16.9571 15.5429L18 16.5858L19.0429 15.5429C19.4334 15.1524 20.0666 15.1524 20.4571 15.5429C20.8476 15.9334 20.8476 16.5666 20.4571 16.9571L19.4142 18L20.4571 19.0429C20.8476 19.4334 20.8476 20.0666 20.4571 20.4571C20.0666 20.8476 19.4334 20.8476 19.0429 20.4571L18 19.4142L16.9571 20.4571C16.5666 20.8476 15.9334 20.8476 15.5429 20.4571C15.1524 20.0666 15.1524 19.4334 15.5429 19.0429L16.5858 18L15.5429 16.9571C15.1524 16.5666 15.1524 15.9334 15.5429 15.5429Z"
      fill="currentColor"
    />
  </svg>
)

export const LibraryIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.2324 8.35396C13.966 7.4249 14.5031 6.45579 15.4322 6.18939L16.8741 5.77593C17.8032 5.50953 18.7723 6.04672 19.0387 6.97577L22.2085 18.0303C22.4749 18.9593 21.9377 19.9285 21.0087 20.1949L19.5668 20.6083C18.6377 20.8747 17.6686 20.3375 17.4022 19.4085L14.2324 8.35396Z"
      fill="currentColor"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8.75 3C7.7835 3 7 3.7835 7 4.75V19.25C7 20.2165 7.7835 21 8.75 21H12.25C13.2165 21 14 20.2165 14 19.25V4.75C14 3.7835 13.2165 3 12.25 3H8.75ZM8.5 7.75C8.5 7.33579 8.83579 7 9.25 7H11.75C12.1642 7 12.5 7.33579 12.5 7.75C12.5 8.16421 12.1642 8.5 11.75 8.5H9.25C8.83579 8.5 8.5 8.16421 8.5 7.75ZM12.5 16.25C12.5 15.8358 12.1642 15.5 11.75 15.5H9.25C8.83579 15.5 8.5 15.8358 8.5 16.25C8.5 16.6642 8.83579 17 9.25 17H11.75C12.1642 17 12.5 16.6642 12.5 16.25Z"
      fill="currentColor"
    />
    <path
      d="M3.75 5C2.7835 5 2 5.7835 2 6.75V19.25C2 20.2165 2.7835 21 3.75 21H4.25C5.2165 21 6 20.2165 6 19.25V6.75C6 5.7835 5.2165 5 4.25 5H3.75Z"
      fill="currentColor"
    />
  </svg>
)

export const PageIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M9 12H15M9 16H15M17 21H7C5.89543 21 5 20.1046 5 19V5C5 3.89543 5.89543 3 7 3H12.5858C12.851 3 13.1054 3.10536 13.2929 3.29289L18.7071 8.70711C18.8946 8.89464 19 9.149 19 9.41421V19C19 20.1046 18.1046 21 17 21Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const AtSignIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M16.7368 19.6541C15.361 20.5073 13.738 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12C21 13.9262 20.0428 15.9154 17.8101 15.7125C15.9733 15.5455 14.6512 13.8737 14.9121 12.0479L15.4274 8.5M14.8581 12.4675C14.559 14.596 12.8066 16.1093 10.9442 15.8476C9.08175 15.5858 7.81444 13.6481 8.11358 11.5196C8.41272 9.39109 10.165 7.87778 12.0275 8.13953C13.8899 8.40128 15.1573 10.339 14.8581 12.4675Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
)

export const IterateIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <path
      d="M5 6C5 5.44772 5.44772 5 6 5H8C8.55228 5 9 4.55228 9 4C9 3.44772 8.55228 3 8 3H6C4.34315 3 3 4.34315 3 6V8C3 8.55228 3.44772 9 4 9C4.55228 9 5 8.55228 5 8V6Z"
      fill="currentColor"
    />
    <path
      d="M16 3C15.4477 3 15 3.44772 15 4C15 4.55228 15.4477 5 16 5H18C18.5523 5 19 5.44772 19 6V8C19 8.55228 19.4477 9 20 9C20.5523 9 21 8.55228 21 8V6C21 4.34315 19.6569 3 18 3H16Z"
      fill="currentColor"
    />
    <path
      d="M10.4312 9.43113C10.8921 9.15753 11.4314 9 12 9C13.3965 9 14.5725 9.95512 14.9055 11.2493C15.0432 11.7841 15.5884 12.1061 16.1232 11.9684C16.6581 11.8308 16.9801 11.2856 16.8424 10.7507C16.2874 8.59442 14.3312 7 12 7C10.8817 7 9.83411 7.36805 8.99002 7.98997L8.35355 7.3535C8.03857 7.03852 7.5 7.26161 7.5 7.70706V9.99995C7.5 10.5522 7.94772 11 8.5 11H10.7929C11.2383 11 11.4614 10.4614 11.1464 10.1464L10.4312 9.43113Z"
      fill="currentColor"
    />
    <path
      d="M9.09445 12.7507C8.95679 12.2159 8.41161 11.8939 7.87676 12.0316C7.34191 12.1692 7.01992 12.7144 7.15758 13.2493C7.71258 15.4056 9.66883 17 12 17C13.1186 17 14.1664 16.6316 15.0101 16.01L15.6464 16.6464C15.9614 16.9614 16.5 16.7383 16.5 16.2928V14C16.5 13.4477 16.0523 13 15.5 13H13.2071C12.7617 13 12.5386 13.5385 12.8536 13.8535L13.5689 14.5688C13.1077 14.8426 12.5685 15 12 15C10.6035 15 9.42754 14.0449 9.09445 12.7507Z"
      fill="currentColor"
    />
    <path
      d="M5 16C5 15.4477 4.55228 15 4 15C3.44772 15 3 15.4477 3 16V18C3 19.6569 4.34315 21 6 21H8C8.55228 21 9 20.5523 9 20C9 19.4477 8.55228 19 8 19H6C5.44772 19 5 18.5523 5 18V16Z"
      fill="currentColor"
    />
    <path
      d="M21 16C21 15.4477 20.5523 15 20 15C19.4477 15 19 15.4477 19 16V18C19 18.5523 18.5523 19 18 19H16C15.4477 19 15 19.4477 15 20C15 20.5523 15.4477 21 16 21H18C19.6569 21 21 19.6569 21 18V16Z"
      fill="currentColor"
    />
  </svg>
)

export function PlanIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M13 16H20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 18C7.10457 18 8 17.1046 8 16C8 14.8954 7.10457 14 6 14C4.89543 14 4 14.8954 4 16C4 17.1046 4.89543 18 6 18Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 8H20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 8.75L5.5 10L8.5 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function QuestionIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M12.0218 11.6633C12.1234 10.9868 12.5019 10.6214 12.8813 10.3636C13.2524 10.1113 13.6234 9.78387 13.6234 9.17768C13.6234 8.34097 12.9522 7.66333 12.1234 7.66333C11.2946 7.66333 10.6234 8.34097 10.6234 9.17768M11.9977 20.5358L14.7377 18.2657C14.9171 18.1171 15.1427 18.0358 15.3757 18.0358L18.002 18.0358C19.1065 18.0357 20.002 17.1403 20.002 16.0358V6C20.002 4.89543 19.1065 4 18.0019 4L6.00195 4.00002C4.89738 4.00002 4.00195 4.89545 4.00195 6.00002V16.0358C4.00195 17.1403 4.89738 18.0358 6.00195 18.0358H8.65157C8.8865 18.0358 9.11393 18.1185 9.29398 18.2694L11.9977 20.5358Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M11.125 14.5C11.125 14.9832 11.5168 15.375 12 15.375C12.4832 15.375 12.875 14.9832 12.875 14.5C12.875 14.0168 12.4832 13.625 12 13.625C11.5168 13.625 11.125 14.0168 11.125 14.5Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="0.75"
        />
      </g>
    </svg>
  )
}

// Small 12x12 icons for badge in shapes list
export function AgentIconSmall({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M4.59516 4.07327C4.96391 3.86808 5.39538 3.74993 5.8503 3.74993C6.96759 3.74993 7.90847 4.46624 8.17489 5.43684C8.28506 5.83792 8.72126 6.07941 9.14913 5.97614C9.57709 5.87294 9.83471 5.46406 9.72454 5.0629C9.28051 3.44576 7.71542 2.25 5.8503 2.25C4.95559 2.25 4.11744 2.52603 3.44212 2.99245L2.9329 2.51511C2.68089 2.27889 2.25 2.4462 2.25 2.78027V4.49986C2.25 4.91403 2.60821 5.24987 3.05007 5.24987H4.88454C5.24089 5.24987 5.41938 4.84594 5.16736 4.6097L4.59516 4.07327Z"
        fill="currentColor"
      />
      <path
        d="M3.82507 6.56316C3.71493 6.16208 3.27875 5.92059 2.85084 6.02386C2.42292 6.12706 2.16531 6.53594 2.27545 6.9371C2.71948 8.55425 4.28461 9.75 6.1497 9.75C7.04466 9.75 7.88297 9.47371 8.55798 9.00753L9.06706 9.48481C9.31908 9.72105 9.75 9.55373 9.75 9.21962V7.5001C9.75 7.08589 9.39181 6.75013 8.94993 6.75013H7.11546C6.75911 6.75013 6.58062 7.15399 6.83264 7.39023L7.40493 7.92668C7.03594 8.13202 6.60454 8.25007 6.1497 8.25007C5.03241 8.25007 4.09156 7.53377 3.82507 6.56316Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function ExploreIconSmall({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <g transform="scale(1.15) translate(-0.9, -0.9)">
        <path
          d="M4.54688 7.17187C4.54688 7.35309 4.69379 7.5 4.875 7.5C5.05621 7.5 5.20312 7.35309 5.20312 7.17187C5.20312 6.41439 5.37073 5.9439 5.65731 5.65731C5.9439 5.37073 6.41439 5.20312 7.17187 5.20312C7.35309 5.20312 7.5 5.05621 7.5 4.875C7.5 4.69379 7.35309 4.54688 7.17187 4.54688C6.41439 4.54688 5.9439 4.37927 5.65731 4.09269C5.37073 3.80611 5.20312 3.3356 5.20312 2.57813C5.20312 2.39691 5.05621 2.25 4.875 2.25C4.69379 2.25 4.54688 2.39691 4.54688 2.57813C4.54688 3.3356 4.37927 3.80611 4.09269 4.09269C3.80611 4.37927 3.3356 4.54688 2.57813 4.54688C2.39691 4.54688 2.25 4.69379 2.25 4.875C2.25 5.05621 2.39691 5.20312 2.57813 5.20312C3.3356 5.20312 3.80611 5.37073 4.09269 5.65731C4.37927 5.9439 4.54688 6.41439 4.54688 7.17187Z"
          fill="currentColor"
        />
        <path
          d="M7.53408 9.40902C7.53408 9.59731 7.6867 9.75 7.87498 9.75C8.06323 9.75 8.21592 9.59731 8.21592 9.40902C8.21592 8.91802 8.32494 8.64219 8.48357 8.48357C8.64219 8.32494 8.91802 8.21592 9.40902 8.21592C9.59731 8.21592 9.75 8.06323 9.75 7.87498C9.75 7.6867 9.59731 7.53408 9.40902 7.53408C8.91802 7.53408 8.64219 7.42505 8.48357 7.2664C8.32494 7.10774 8.21592 6.83195 8.21592 6.3409C8.21592 6.15262 8.06323 6 7.87498 6C7.6867 6 7.53408 6.15262 7.53408 6.3409C7.53408 6.83195 7.42505 7.10774 7.2664 7.2664C7.10774 7.42505 6.83195 7.53408 6.3409 7.53408C6.15262 7.53408 6 7.6867 6 7.87498C6 8.06323 6.15262 8.21592 6.3409 8.21592C6.83195 8.21592 7.10774 8.32494 7.2664 8.48357C7.42505 8.64219 7.53408 8.91802 7.53408 9.40902Z"
          fill="currentColor"
        />
      </g>
    </svg>
  )
}

export function PlanIconSmall({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M2 3H10M2 6H7M2 9H5"
        stroke="currentColor"
        strokeWidth="1.33333"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Small 12x12 version of the new Prototype icon (matches ExploreIcon in mode-toggle-button)
export function PrototypeIconSmall({ className }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M17.2929 3.29289C17.6834 2.90237 18.3166 2.90237 18.7071 3.29289L20.7071 5.29289C21.0976 5.68342 21.0976 6.31658 20.7071 6.70711L18.7071 8.70711C18.3166 9.09763 17.6834 9.09763 17.2929 8.70711C16.9024 8.31658 16.9024 7.68342 17.2929 7.29289L17.5858 7H14C13.4477 7 13 7.44772 13 8V16C13 17.6569 11.6569 19 10 19H8.82929C8.41746 20.1652 7.30622 21 6 21C4.34315 21 3 19.6569 3 18C3 16.3431 4.34315 15 6 15C7.30622 15 8.41746 15.8348 8.82929 17H10C10.5523 17 11 16.5523 11 16V8C11 6.34315 12.3431 5 14 5H17.5858L17.2929 4.70711C16.9024 4.31658 16.9024 3.68342 17.2929 3.29289ZM3.54289 3.54289C3.93342 3.15237 4.56658 3.15237 4.95711 3.54289L6 4.58579L7.04289 3.54289C7.43342 3.15237 8.06658 3.15237 8.45711 3.54289C8.84763 3.93342 8.84763 4.56658 8.45711 4.95711L7.41421 6L8.45711 7.04289C8.84763 7.43342 8.84763 8.06658 8.45711 8.45711C8.06658 8.84763 7.43342 8.84763 7.04289 8.45711L6 7.41421L4.95711 8.45711C4.56658 8.84763 3.93342 8.84763 3.54289 8.45711C3.15237 8.06658 3.15237 7.43342 3.54289 7.04289L4.58579 6L3.54289 4.95711C3.15237 4.56658 3.15237 3.93342 3.54289 3.54289ZM15.5429 15.5429C15.9334 15.1524 16.5666 15.1524 16.9571 15.5429L18 16.5858L19.0429 15.5429C19.4334 15.1524 20.0666 15.1524 20.4571 15.5429C20.8476 15.9334 20.8476 16.5666 20.4571 16.9571L19.4142 18L20.4571 19.0429C20.8476 19.4334 20.8476 20.0666 20.4571 20.4571C20.0666 20.8476 19.4334 20.8476 19.0429 20.4571L18 19.4142L16.9571 20.4571C16.5666 20.8476 15.9334 20.8476 15.5429 20.4571C15.1524 20.0666 15.1524 19.4334 15.5429 19.0429L16.5858 18L15.5429 16.9571C15.1524 16.5666 15.1524 15.9334 15.5429 15.5429Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function QuestionsSkippedIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M8 19L16 19"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M16 5H21V10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20.5 5.5C16 9.5 12.5 13.5 12 19"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M12 18.9999V18.9122C12 12.9251 7.5 7 2 7.06002"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  )
}

export const TeamIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    {...props}
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5.75 3C4.23122 3 3 4.23122 3 5.75V18.5H1.75C1.33579 18.5 1 18.8358 1 19.25C1 19.6642 1.33579 20 1.75 20H22.25C22.6642 20 23 19.6642 23 19.25C23 18.8358 22.6642 18.5 22.25 18.5H21V9.75C21 8.23122 19.7688 7 18.25 7H16V18.5H15V5.75C15 4.23122 13.7688 3 12.25 3H5.75ZM7.75 8C7.33579 8 7 8.33579 7 8.75C7 9.16421 7.33579 9.5 7.75 9.5H10.25C10.6642 9.5 11 9.16421 11 8.75C11 8.33579 10.6642 8 10.25 8H7.75ZM7.75 12C7.33579 12 7 12.3358 7 12.75C7 13.1642 7.33579 13.5 7.75 13.5H10.25C10.6642 13.5 11 13.1642 11 12.75C11 12.3358 10.6642 12 10.25 12H7.75Z"
      fill="currentColor"
    />
  </svg>
)

export const ChipIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    {...props}
  >
    <path d="M14.5 14.5H9.5V9.5H14.5V14.5Z" fill="currentColor" />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M14.25 1C14.6642 1 15 1.33579 15 1.75V3H18.25C19.7688 3 21 4.23122 21 5.75V9H22.25L22.3271 9.00391C22.7051 9.04253 23 9.36183 23 9.75C23 10.1382 22.7051 10.4575 22.3271 10.4961L22.25 10.5H21V13.5H22.25L22.3271 13.5039C22.7051 13.5425 23 13.8618 23 14.25C23 14.6382 22.7051 14.9575 22.3271 14.9961L22.25 15H21V18.25C21 19.7688 19.7688 21 18.25 21H15V22.25C15 22.6642 14.6642 23 14.25 23C13.8358 23 13.5 22.6642 13.5 22.25V21H10.5V22.25C10.5 22.6642 10.1642 23 9.75 23C9.33579 23 9 22.6642 9 22.25V21H5.75C4.23122 21 3 19.7688 3 18.25V15H1.75C1.33579 15 1 14.6642 1 14.25C1 13.8358 1.33579 13.5 1.75 13.5H3V10.5H1.75C1.33579 10.5 1 10.1642 1 9.75C1 9.33579 1.33579 9 1.75 9H3V5.75C3 4.23122 4.23122 3 5.75 3H9V1.75C9 1.33579 9.33579 1 9.75 1C10.1642 1 10.5 1.33579 10.5 1.75V3H13.5V1.75C13.5 1.33579 13.8358 1 14.25 1ZM8.75 8C8.36183 8 8.04253 8.29488 8.00391 8.67285L8 8.75V15.25C8 15.6642 8.33579 16 8.75 16H15.25C15.6642 16 16 15.6642 16 15.25V8.75C16 8.36183 15.7051 8.04253 15.3271 8.00391L15.25 8H8.75Z"
      fill="currentColor"
    />
  </svg>
)

export const MembersIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    {...props}
  >
    <path
      d="M3.99854 7C3.99854 4.79086 5.7894 3 7.99854 3C10.2077 3 11.9985 4.79086 11.9985 7C11.9985 9.20914 10.2077 11 7.99854 11C5.7894 11 3.99854 9.20914 3.99854 7Z"
      fill="currentColor"
    />
    <path
      d="M13.4985 7.5C13.4985 5.567 15.0655 4 16.9985 4C18.9315 4 20.4985 5.567 20.4985 7.5C20.4985 9.433 18.9315 11 16.9985 11C15.0655 11 13.4985 9.433 13.4985 7.5Z"
      fill="currentColor"
    />
    <path
      d="M7.99874 12C6.23369 12 4.76256 12.6347 3.63361 13.7201C2.51685 14.7939 1.76592 16.2768 1.35206 17.9455C0.932102 19.6387 2.3507 21 3.90031 21H12.0972C13.6468 21 15.0654 19.6387 14.6454 17.9455C14.2316 16.2768 13.4806 14.7939 12.3639 13.7201C11.2349 12.6347 9.76378 12 7.99874 12Z"
      fill="currentColor"
    />
    <path
      d="M14.1733 12.7148C15.3832 14.0522 16.1557 15.7263 16.5867 17.464C16.8183 18.398 16.754 19.2543 16.484 20H20.3444C21.8822 20 23.3404 18.6346 22.8534 16.925C22.0601 14.1398 20.1047 12 16.9984 12C15.9171 12 14.9752 12.2593 14.1733 12.7148Z"
      fill="currentColor"
    />
  </svg>
)

export const PullRequestIcon = (props: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    {...props}
  >
    <circle
      cx="6"
      cy="6"
      r="2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle
      cx="6"
      cy="18"
      r="2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle
      cx="18"
      cy="18"
      r="2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M6 8V16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13 6H16C17.1046 6 18 6.89543 18 8V16"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M14 4L12 6L14 8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const InviteUserIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
  >
    <g transform="scale(1.05) translate(-1.2, -1.2)">
      <path
        d="M14.0011 13.2499C13.3739 13.0868 12.7051 13 12.0011 13C8.60997 13 6.03711 15.0143 4.9836 17.8629C4.5748 18.9682 5.51944 20 6.69796 20H11.0011M18.0011 15V18M18.0011 18V21M18.0011 18H15.0011M18.0011 18H21.0011M15.5011 6.5C15.5011 8.433 13.9341 10 12.0011 10C10.0681 10 8.50112 8.433 8.50112 6.5C8.50112 4.567 10.0681 3 12.0011 3C13.9341 3 15.5011 4.567 15.5011 6.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const TicketIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M15 5l0 2" />
    <path d="M15 11l0 2" />
    <path d="M15 17l0 2" />
    <path d="M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-3a2 2 0 0 0 0 -4v-3a2 2 0 0 1 2 -2" />
  </svg>
)

export const FollowingIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
  >
    <path
      d="M17 20C17 18.3431 14.7614 17 12 17C9.23858 17 7 18.3431 7 20M21 17.0004C21 15.7702 19.7659 14.7129 18 14.25M3 17.0004C3 15.7702 4.2341 14.7129 6 14.25M18 10.2361C18.6137 9.68679 19 8.8885 19 8C19 6.34315 17.6569 5 16 5C15.2316 5 14.5308 5.28885 14 5.76389M6 10.2361C5.38625 9.68679 5 8.8885 5 8C5 6.34315 6.34315 5 8 5C8.76835 5 9.46924 5.28885 10 5.76389M12 14C10.3431 14 9 12.6569 9 11C9 9.34315 10.3431 8 12 8C13.6569 8 15 9.34315 15 11C15 12.6569 13.6569 14 12 14Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

export const FollowPersonPlusIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
  >
    <g transform="scale(1.15) translate(-1.6, -1.6)">
      <path
        d="M15.5 6.5C15.5 8.433 13.933 10 12 10C10.067 10 8.5 8.433 8.5 6.5C8.5 4.567 10.067 3 12 3C13.933 3 15.5 4.567 15.5 6.5Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.0011 13.2499C13.3739 13.0868 12.7051 13 12.0011 13C8.60997 13 6.03711 15.0143 4.9836 17.8629C4.5748 18.9682 5.51944 20 6.69796 20H11.0011"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 15V18M18 18V21M18 18H15M18 18H21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export const InviteTeamIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    {...props}
  >
    <path
      d="M12 2C9.51472 2 7.5 4.01472 7.5 6.5C7.5 8.98528 9.51472 11 12 11C14.4853 11 16.5 8.98528 16.5 6.5C16.5 4.01472 14.4853 2 12 2Z"
      fill="currentColor"
    />
    <path
      d="M18 14C18.5523 14 19 14.4477 19 15V17H21C21.5523 17 22 17.4477 22 18C22 18.5523 21.5523 19 21 19H19V21C19 21.5523 18.5523 22 18 22C17.4477 22 17 21.5523 17 21V19H15C14.4477 19 14 18.5523 14 18C14 17.4477 14.4477 17 15 17H17V15C17 14.4477 17.4477 14 18 14Z"
      fill="currentColor"
    />
    <path
      d="M3.69691 18.6964C4.55378 14.8837 7.70183 12 12.001 12C13.4328 12 14.7368 12.3198 15.8711 12.8873C15.3332 13.4295 15.001 14.1759 15.001 15C13.3441 15 12.001 16.3431 12.001 18C12.001 19.6569 13.3441 21 15.001 21H5.59944C4.46429 21 3.40713 19.9858 3.69691 18.6964Z"
      fill="currentColor"
    />
  </svg>
)

export const MoveToTeamIcon = ({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    {...props}
  >
    <g transform="scale(1.15) translate(-1.8, -1.8)">
      <path
        d="M10 9H8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 13H10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M20 19V10C20 8.89543 19.1046 8 18 8H14"
        stroke="currentColor"
        strokeWidth="2"
        strokeMiterlimit="16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 19V6C14 4.89543 13.1046 4 12 4H6C4.89543 4 4 4.89543 4 6V19"
        stroke="currentColor"
        strokeWidth="2"
        strokeMiterlimit="16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 19H2"
        stroke="currentColor"
        strokeWidth="2"
        strokeMiterlimit="16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  </svg>
)

export function QuestionCircleIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.8, -1.8)">
        <path
          d="M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12 16V16.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M12 13C12 11.3608 14 11.9319 14 10C14 8.89543 13.1046 8 12 8C11.2597 8 10.6134 8.4022 10.2676 9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function AIResearchIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M9 4.29004C6.10851 5.15059 4 7.82914 4 11.0002C4 14.8662 7.13401 18.0002 11 18.0002C14.1711 18.0002 16.8497 15.8916 17.7102 13"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M19.9998 19.9998L16.0498 16.0498"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M17.2405 4.18518L16.5436 2.37334C16.4571 2.14842 16.241 2 16 2C15.759 2 15.5429 2.14842 15.4564 2.37334L14.7595 4.18518C14.658 4.44927 14.4493 4.65797 14.1852 4.75955L12.3733 5.45641C12.1484 5.54292 12 5.75901 12 6C12 6.24099 12.1484 6.45708 12.3733 6.54359L14.1852 7.24045C14.4493 7.34203 14.658 7.55073 14.7595 7.81482L15.4564 9.62666C15.5429 9.85158 15.759 10 16 10C16.241 10 16.4571 9.85158 16.5436 9.62666L17.2405 7.81482C17.342 7.55073 17.5507 7.34203 17.8148 7.24045L19.6267 6.54359C19.8516 6.45708 20 6.24099 20 6C20 5.75901 19.8516 5.54292 19.6267 5.45641L17.8148 4.75955C17.5507 4.65797 17.342 4.44927 17.2405 4.18518Z"
          fill="currentColor"
        />
      </g>
    </svg>
  )
}

export function MagicChatPlusIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M20.2405 4.18518L19.5436 2.37334C19.4571 2.14842 19.241 2 19 2C18.759 2 18.5429 2.14842 18.4564 2.37334L17.7595 4.18518C17.658 4.44927 17.4493 4.65797 17.1852 4.75955L15.3733 5.45641C15.1484 5.54292 15 5.75901 15 6C15 6.24099 15.1484 6.45708 15.3733 6.54359L17.1852 7.24045C17.4493 7.34203 17.658 7.55073 17.7595 7.81482L18.4564 9.62666C18.5429 9.85158 18.759 10 19 10C19.241 10 19.4571 9.85158 19.5436 9.62666L20.2405 7.81482C20.342 7.55073 20.5507 7.34203 20.8148 7.24045L22.6267 6.54359C22.8516 6.45708 23 6.24099 23 6C23 5.75901 22.8516 5.54292 22.6267 5.45641L20.8148 4.75955C20.5507 4.65797 20.342 4.44927 20.2405 4.18518Z"
          fill="currentColor"
        />
        <path
          d="M21.002 13.0179V16.0358C21.002 17.1403 20.1065 18.0358 19.002 18.0358L15.3757 18.0358C15.1427 18.0358 14.9171 18.1171 14.7377 18.2657L11.9977 20.5358L9.29398 18.2694C9.11393 18.1185 8.8865 18.0358 8.65157 18.0358H5.00195C3.89738 18.0358 3.00195 17.1403 3.00195 16.0358L3.00195 6.00003C3.00195 4.89546 3.89738 4.00003 5.00195 4.00002L12.002 4.00001"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function ContributeIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M17 5C17 5 18 6.1 18 7C19 6.1 20 6.1 20 6.1"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.00011 7L4.90011 6.99993V7H4.00011ZM12.0001 6.5H11.1001C11.1001 6.30527 11.1633 6.11579 11.2801 5.96L12.0001 6.5ZM12.4594 5.88767L13.1794 6.42767L13.1794 6.42767L12.4594 5.88767ZM12.2736 3.27346L11.6372 3.90985L12.2736 3.27346ZM12.0001 3L11.4209 2.31116C11.7783 2.0106 12.3063 2.03338 12.6365 2.3636L12.0001 3ZM11.0001 3.5L10.9473 2.60155L11.0001 3.5ZM9.50011 2L8.73162 1.53158C8.90651 1.24465 9.22668 1.07905 9.56191 1.10212C9.89715 1.1252 10.1916 1.33311 10.3255 1.64129L9.50011 2ZM8.50011 3L8.82998 3.83737L8.50011 3ZM4.00011 7H4.90011C4.90011 8.71208 6.28803 10.1 8.00011 10.1V11V11.9C5.29391 11.9 3.10011 9.7062 3.10011 7H4.00011ZM8.00011 11V10.1C9.71219 10.1 11.1001 8.71208 11.1001 7H12.0001H12.9001C12.9001 9.7062 10.7063 11.9 8.00011 11.9V11ZM12.0001 6.5L11.2801 5.96L11.7394 5.34767L12.4594 5.88767L13.1794 6.42767L12.7201 7.04L12.0001 6.5ZM12.2736 3.27346L11.6372 3.90985L11.3637 3.6364L12.0001 3L12.6365 2.3636L12.91 2.63706L12.2736 3.27346ZM12.0001 3C12.5793 3.68884 12.5792 3.68894 12.5791 3.68905C12.579 3.68908 12.5789 3.68919 12.5788 3.68926C12.5787 3.68941 12.5785 3.68957 12.5783 3.68973C12.5779 3.69006 12.5775 3.69042 12.577 3.6908C12.5761 3.69158 12.575 3.69247 12.5738 3.69347C12.5714 3.69548 12.5684 3.69795 12.5648 3.70085C12.5578 3.70665 12.5485 3.71419 12.5372 3.72323C12.5147 3.74126 12.4838 3.76549 12.4459 3.79395C12.371 3.85024 12.2648 3.92616 12.1394 4.00429C11.9284 4.13577 11.5128 4.3714 11.053 4.39845L11.0001 3.5L10.9473 2.60155C10.916 2.60339 10.9277 2.60825 10.991 2.58159C11.048 2.55759 11.1159 2.52123 11.1877 2.47648C11.2578 2.43281 11.3199 2.38854 11.3644 2.35509C11.3862 2.33867 11.4028 2.32565 11.4128 2.31764C11.4178 2.31365 11.4211 2.31098 11.4225 2.30981C11.4232 2.30923 11.4234 2.30904 11.4232 2.30925C11.423 2.30936 11.4228 2.30957 11.4224 2.30988C11.4222 2.31004 11.422 2.31023 11.4217 2.31044C11.4216 2.31055 11.4215 2.31066 11.4213 2.31078C11.4213 2.31084 11.4212 2.31093 11.4211 2.31096C11.421 2.31106 11.4209 2.31116 12.0001 3ZM11.0001 3.5L11.053 4.39845C10.5489 4.4281 10.1413 4.21022 9.86723 3.99883C9.59033 3.78529 9.36938 3.5183 9.2071 3.29062C9.04069 3.05715 8.90987 2.82779 8.82177 2.6604C8.77711 2.57556 8.74197 2.50384 8.71731 2.45179C8.70495 2.42571 8.69514 2.40439 8.68802 2.38865C8.68445 2.38077 8.68154 2.37428 8.67932 2.36926C8.67821 2.36675 8.67726 2.3646 8.67649 2.36284C8.6761 2.36196 8.67576 2.36118 8.67546 2.36049C8.67531 2.36014 8.67517 2.35982 8.67504 2.35952C8.67497 2.35938 8.67488 2.35917 8.67485 2.3591C8.67477 2.3589 8.67468 2.35871 9.50011 2C10.3255 1.64129 10.3255 1.64111 10.3254 1.64094C10.3254 1.64089 10.3253 1.64072 10.3252 1.64062C10.3252 1.64041 10.3251 1.64023 10.325 1.64008C10.3249 1.63976 10.3248 1.63954 10.3247 1.6394C10.3246 1.63913 10.3246 1.63921 10.3248 1.63963C10.3252 1.64046 10.3262 1.64266 10.3277 1.64611C10.3309 1.65303 10.3363 1.66494 10.344 1.68111C10.3594 1.71356 10.3832 1.76245 10.4146 1.82203C10.4785 1.94349 10.5677 2.09825 10.6729 2.24586C10.7822 2.39927 10.8846 2.51032 10.9665 2.57346C11.0511 2.63877 11.0378 2.59622 10.9473 2.60155L11.0001 3.5ZM9.50011 2C10.2686 2.46842 10.2685 2.46856 10.2684 2.4687C10.2684 2.46875 10.2683 2.46889 10.2683 2.469C10.2681 2.4692 10.268 2.46942 10.2679 2.46965C10.2676 2.4701 10.2673 2.47061 10.2669 2.47117C10.2662 2.47228 10.2654 2.4736 10.2645 2.4751C10.2626 2.47811 10.2603 2.48189 10.2575 2.4864C10.2518 2.49541 10.2443 2.50736 10.2349 2.5219C10.2162 2.55091 10.1902 2.59052 10.1576 2.63782C10.0932 2.73156 10.0003 2.85982 9.88644 2.99756C9.68902 3.23635 9.31543 3.64613 8.82998 3.83737L8.50011 3L8.17024 2.16263C8.16631 2.16418 8.20429 2.14779 8.28006 2.08141C8.35063 2.01958 8.42594 1.93918 8.49916 1.85062C8.57106 1.76366 8.63186 1.67988 8.67459 1.61775C8.69566 1.58711 8.71159 1.56283 8.72151 1.54744C8.72645 1.53976 8.72984 1.53438 8.73157 1.53161C8.73244 1.53023 8.73288 1.52951 8.7329 1.52949C8.7329 1.52948 8.7328 1.52964 8.73259 1.52999C8.73248 1.53016 8.73235 1.53038 8.73219 1.53064C8.7321 1.53078 8.73202 1.53092 8.73192 1.53108C8.73187 1.53115 8.7318 1.53128 8.73177 1.53132C8.7317 1.53145 8.73162 1.53158 9.50011 2ZM6.50011 3.5V4.4C5.87765 4.4 5.53197 4.67518 5.29017 5.11848C5.01684 5.61956 4.90006 6.32357 4.90011 6.99993L4.00011 7L3.10011 7.00007C3.10005 6.17643 3.23327 5.13044 3.70997 4.25652C4.21819 3.32482 5.12257 2.6 6.50011 2.6V3.5ZM8.50011 3L8.82998 3.83737C7.53206 4.34867 6.69607 4.4 6.50011 4.4V3.5V2.6C6.46078 2.6 7.07344 2.5947 8.17024 2.16263L8.50011 3ZM12.4594 5.88767L11.7394 5.34767C12.0678 4.90974 12.0243 4.29694 11.6372 3.90986L12.2736 3.27346L12.91 2.63706C13.9304 3.65755 14.0453 5.27312 13.1794 6.42767L12.4594 5.88767ZM12.0001 6.5H12.9001V7H12.0001H11.1001V6.5H12.0001Z"
          fill="currentColor"
        />
        <rect
          width="4"
          height="2.5"
          rx="0.5"
          transform="matrix(-1 0 0 1 8 6)"
          fill="currentColor"
        />
        <rect
          width="3"
          height="2.5"
          rx="0.5"
          transform="matrix(-1 0 0 1 12 6)"
          fill="currentColor"
        />
        <path
          d="M9.5 6.75H7.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2 20C2 15.4635 5.48364 13.4994 8.5 14.108"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M11 20H19.2457C19.6922 20 20.0846 19.704 20.2072 19.2747L21.5994 14.4022C21.8001 13.6995 21.2725 13 20.5417 13H14.1315C13.4617 13 12.8732 13.444 12.6892 14.0879L11 20ZM11 20H7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function SyncIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M5 4V7.25C5 7.66421 5.33579 8 5.75 8H8.75M19.0118 20V16.75C19.0118 16.3358 18.6761 16 18.2618 16H15.0118M4 12C4 16.4183 7.58172 20 12 20C14.6362 20 17.0303 18.7249 18.5 16.7578M20 12C20 7.58172 16.4183 4 12 4C9.36378 4 6.96969 5.27512 5.5 7.24224"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function BranchIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <circle
          cx="6.5"
          cy="6"
          r="2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx="6.5"
          cy="18"
          r="2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle
          cx="17.5"
          cy="6"
          r="2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M6.5 8V16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M17.5 8V10C17.5 11.1046 16.6046 12 15.5 12H8.5C7.39543 12 6.5 12.8954 6.5 14V16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function CalendarDotsIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M6 4V3C4.34315 3 3 4.34315 3 6H4H5C5 5.44772 5.44772 5 6 5V4ZM6 4V5H18V4V3H6V4ZM18 4V5C18.5523 5 19 5.44772 19 6H20H21C21 4.34315 19.6569 3 18 3V4ZM20 6H19V8H20H21V6H20ZM20 8H19V18H20H21V8H20ZM20 18H19C19 18.5523 18.5523 19 18 19V20V21C19.6569 21 21 19.6569 21 18H20ZM18 20V19H6V20V21H18V20ZM6 20V19C5.44772 19 5 18.5523 5 18H4H3C3 19.6569 4.34315 21 6 21V20ZM4 18H5V8H4H3V18H4ZM4 8H5V6H4H3V8H4Z"
        fill="currentColor"
      />
      <path
        d="M4 8H20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M9.25 12C9.25 12.6904 8.69036 13.25 8 13.25C7.30964 13.25 6.75 12.6904 6.75 12C6.75 11.3096 7.30964 10.75 8 10.75C8.69036 10.75 9.25 11.3096 9.25 12Z"
        fill="currentColor"
      />
      <path
        d="M17.25 12C17.25 12.6904 16.6904 13.25 16 13.25C15.3096 13.25 14.75 12.6904 14.75 12C14.75 11.3096 15.3096 10.75 16 10.75C16.6904 10.75 17.25 11.3096 17.25 12Z"
        fill="currentColor"
      />
      <path
        d="M13.25 12C13.25 12.6904 12.6904 13.25 12 13.25C11.3096 13.25 10.75 12.6904 10.75 12C10.75 11.3096 11.3096 10.75 12 10.75C12.6904 10.75 13.25 11.3096 13.25 12Z"
        fill="currentColor"
      />
      <path
        d="M9.25 16C9.25 16.6904 8.69036 17.25 8 17.25C7.30964 17.25 6.75 16.6904 6.75 16C6.75 15.3096 7.30964 14.75 8 14.75C8.69036 14.75 9.25 15.3096 9.25 16Z"
        fill="currentColor"
      />
      <path
        d="M13.25 16C13.25 16.6904 12.6904 17.25 12 17.25C11.3096 17.25 10.75 16.6904 10.75 16C10.75 15.3096 11.3096 14.75 12 14.75C12.6904 14.75 13.25 15.3096 13.25 16Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function AuthorIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.15) translate(-1.8, -1.8)">
        <path
          d="M15.5 6.5C15.5 8.433 13.933 10 12 10C10.067 10 8.5 8.433 8.5 6.5C8.5 4.567 10.067 3 12 3C13.933 3 15.5 4.567 15.5 6.5Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d="M12.0011 13C8.60997 13 6.03711 15.0143 4.9836 17.8629C4.5748 18.9682 5.51944 20 6.69796 20H17.3043C18.4828 20 19.4274 18.9682 19.0186 17.8629C17.9651 15.0143 15.3923 13 12.0011 13Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function LibraryOutlineIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.2, -1.2)">
        <path
          d="M2.75 6.75C2.75 6.19772 3.19772 5.75 3.75 5.75H5.75C6.30228 5.75 6.75 6.19772 6.75 6.75V19.25C6.75 19.8023 6.30228 20.25 5.75 20.25H3.75C3.19772 20.25 2.75 19.8023 2.75 19.25V6.75Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
        <path
          d="M14.257 8.46569C14.114 7.93222 14.4306 7.38388 14.9641 7.24094L17.3789 6.59389C17.9124 6.45095 18.4607 6.76753 18.6036 7.301L21.5801 18.4091C21.723 18.9426 21.4064 19.4909 20.873 19.6339L18.4581 20.2809C17.9247 20.4239 17.3763 20.1073 17.2334 19.5738L14.257 8.46569Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
        <path
          d="M6.75 4.75C6.75 4.19772 7.19772 3.75 7.75 3.75H12.25C12.8023 3.75 13.25 4.19772 13.25 4.75V19.25C13.25 19.8023 12.8023 20.25 12.25 20.25H7.75C7.19772 20.25 6.75 19.8023 6.75 19.25V4.75Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
        <path
          d="M6.75 7.875H13.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
        <path
          d="M6.75 16.125H13.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function ServerIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M2.75 6.75C2.75 5.64543 3.64543 4.75 4.75 4.75H19.25C20.3546 4.75 21.25 5.64543 21.25 6.75V12H2.75V6.75Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <path
        d="M2.75 12H21.25V17.25C21.25 18.3546 20.3546 19.25 19.25 19.25H4.75C3.64543 19.25 2.75 18.3546 2.75 17.25V12Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 14.875C6.91421 14.875 7.25 15.2108 7.25 15.625C7.25 16.0392 6.91421 16.375 6.5 16.375C6.08579 16.375 5.75 16.0392 5.75 15.625C5.75 15.2108 6.08579 14.875 6.5 14.875ZM6.5 7.625C6.91421 7.625 7.25 7.96079 7.25 8.375C7.25 8.78921 6.91421 9.125 6.5 9.125C6.08579 9.125 5.75 8.78921 5.75 8.375C5.75 7.96079 6.08579 7.625 6.5 7.625Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="0.5"
      />
    </svg>
  )
}

export function KeyIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M15.5 14.25C18.6756 14.25 21.25 11.6756 21.25 8.5C21.25 5.32436 18.6756 2.75 15.5 2.75C12.3244 2.75 9.75 5.32436 9.75 8.5C9.75 8.98191 9.80928 9.44996 9.92095 9.89728L4.04289 15.7753C3.85536 15.9629 3.75 16.2172 3.75 16.4825V19.2501C3.75 19.8023 4.19772 20.2501 4.75 20.2501H7.5176C7.78282 20.2501 8.03717 20.1447 8.22471 19.9572L9.25 18.9319V16.2501H11.9318L14.1028 14.0791C14.5501 14.1907 15.0181 14.25 15.5 14.25Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17.25 8.5C17.25 9.4665 16.4665 10.25 15.5 10.25C14.5335 10.25 13.75 9.4665 13.75 8.5C13.75 7.5335 14.5335 6.75 15.5 6.75C16.4665 6.75 17.25 7.5335 17.25 8.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="square"
      />
    </svg>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M16.25 5.75H18.25C19.3546 5.75 20.25 6.64543 20.25 7.75V10.75M16.25 5.75V10.75M16.25 5.75C16.25 4.64543 15.3546 3.75 14.25 3.75H5.75C4.64543 3.75 3.75 4.64543 3.75 5.75V7.75M3.75 7.75H7.92157C8.45201 7.75 8.96071 7.96071 9.33579 8.33579L11.1642 10.1642C11.5393 10.5393 12.048 10.75 12.5784 10.75H16.25M3.75 7.75C3.19772 7.75 2.75 8.19772 2.75 8.75V18.25C2.75 19.3546 3.64543 20.25 4.75 20.25H19.25C20.3546 20.25 21.25 19.3546 21.25 18.25V11.75C21.25 11.1977 20.8023 10.75 20.25 10.75M16.25 10.75H20.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function FolderPlusIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M21 10V9C21 7.89543 20.1046 7 19 7H13.0704C12.4017 7 11.7772 6.6658 11.4063 6.1094L10.5937 4.8906C10.2228 4.3342 9.59834 4 8.92963 4H5C3.89543 4 3 4.89543 3 6V17C3 18.1046 3.89543 19 5 19H11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 14V17V20"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M15 17H18H21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g transform="translate(12, 12) scale(1.05) translate(-12, -12.5)">
        <path
          d="M20 16.8V8H4V16.8C4 17.9201 4 18.4802 4.21799 18.908C4.40973 19.2843 4.71569 19.5903 5.09202 19.782C5.51984 20 6.0799 20 7.2 20H16.8C17.9201 20 18.4802 20 18.908 19.782C19.2843 19.5903 19.5903 19.2843 19.782 18.908C20 18.4802 20 17.9201 20 16.8Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3 4H21V8H3V4Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10 12H14"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function PinFilledIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path stroke="none" d="M0 0h24v24H0z" fill="none" />
      <path d="M15.113 3.21l.094 .083l5.5 5.5a1 1 0 0 1 -1.175 1.59l-3.172 3.171l-1.424 3.797a1 1 0 0 1 -.158 .277l-.07 .08l-1.5 1.5a1 1 0 0 1 -1.32 .082l-.095 -.083l-2.793 -2.792l-3.793 3.792a1 1 0 0 1 -1.497 -1.32l.083 -.094l3.792 -3.793l-2.792 -2.793a1 1 0 0 1 -.083 -1.32l.083 -.094l1.5 -1.5a1 1 0 0 1 .258 -.187l.098 -.042l3.796 -1.425l3.171 -3.17a1 1 0 0 1 1.497 -1.26z" />
    </svg>
  )
}

export function AgentIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M12 12L15.2218 15.182C17.0012 16.9393 19.8861 16.9393 21.6655 15.182C23.4448 13.4246 23.4448 10.5754 21.6655 8.81802C19.8861 7.06066 17.0012 7.06066 15.2218 8.81802L12 12ZM12 12L8.77817 8.81802C6.99881 7.06066 4.11389 7.06066 2.33452 8.81802C0.555159 10.5754 0.555159 13.4246 2.33452 15.182C4.11389 16.9393 6.99881 16.9393 8.77817 15.182L12 12Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
      />
    </svg>
  )
}

// Circle filter icon - circle with horizontal filter lines
export function CircleFilterIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 12.75H15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 9.5L16.5 9.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 16H13.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Custom agent icon - robot outline
export function CustomAgentIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M12 4H7C5.89543 4 5 4.89543 5 6V11C5 12.1046 5.89543 13 7 13H17C18.1046 13 19 12.1046 19 11V6C19 4.89543 18.1046 4 17 4H12ZM12 4V2M6 15L4 17M6 15C6 18.3137 8.68629 21 12 21C15.3137 21 18 18.3137 18 15M6 15V13M18 15L20 17M18 15V13M9 8V9M15 8V9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Custom agent icon filled - robot filled
export function CustomAgentIconFilled(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 1C12.5523 1 13 1.44772 13 2V3H17C18.6569 3 20 4.34315 20 6V11C20 11.8885 19.6138 12.6868 19 13.2361V14.5858L20.7071 16.2929C21.0976 16.6834 21.0976 17.3166 20.7071 17.7071C20.3166 18.0976 19.6834 18.0976 19.2929 17.7071L18.681 17.0952C17.7905 19.9377 15.1361 22 12 22C8.8639 22 6.20948 19.9377 5.31897 17.0952L4.70711 17.7071C4.31658 18.0976 3.68342 18.0976 3.29289 17.7071C2.90237 17.3166 2.90237 16.6834 3.29289 16.2929L5 14.5858V13.2361C4.38625 12.6868 4 11.8885 4 11V6C4 4.34315 5.34315 3 7 3H11V2C11 1.44772 11.4477 1 12 1ZM7 5C6.44772 5 6 5.44772 6 6V11C6 11.5523 6.44772 12 7 12H17C17.5523 12 18 11.5523 18 11V6C18 5.44772 17.5523 5 17 5H7ZM9 7C9.55228 7 10 7.44772 10 8V9C10 9.55228 9.55228 10 9 10C8.44772 10 8 9.55228 8 9V8C8 7.44772 8.44772 7 9 7ZM15 7C15.5523 7 16 7.44772 16 8V9C16 9.55228 15.5523 10 15 10C14.4477 10 14 9.55228 14 9V8C14 7.44772 14.4477 7 15 7Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Expand icon (arrows pointing outward) - used for expandable tool outputs
export function ExpandIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M8 8.99989L11.4697 5.53022C11.7626 5.23732 12.2374 5.23732 12.5303 5.53022L16 8.99989M8 14.9999L11.4697 18.4696C11.7626 18.7625 12.2374 18.7625 12.5303 18.4696L16 14.9999"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Collapse icon (arrows pointing inward) - used for collapsible tool outputs
export function CollapseIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M8 18.4694L11.4697 14.9997C11.7626 14.7068 12.2374 14.7068 12.5303 14.9997L16 18.4694M8.0008 5.5L11.4705 8.96971C11.4705 8.96971 12.2382 9.26261 12.5311 8.96971L16.0008 5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Roadmap icon - used for roadmap links
export function RoadmapIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <path
        d="M12.0013 9V4H18.54C19.1476 4 19.7222 4.27618 20.1017 4.75061L20.5017 5.25061C21.0861 5.98105 21.0861 7.01895 20.5017 7.74939L20.1017 8.24939C19.7222 8.72382 19.1476 9 18.54 9H12.0013ZM12.0013 9V14M12.0013 9H5.4625C4.85493 9 4.28031 9.27618 3.90076 9.75061L3.50076 10.2506C2.91641 10.981 2.91641 12.019 3.50076 12.7494L3.90076 13.2494C4.28031 13.7238 4.85493 14 5.4625 14H12.0013M12.0013 14V20M12.0013 20H8.00125M12.0013 20H16.0013"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Claude Code Logo icon
export const ClaudeCodeLogoIcon = (props: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 256 257"
    fill="currentColor"
    {...props}
  >
    <path
      d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
      fill="#D97757"
    />
  </svg>
)

// OpenAI Codex icon
export const CodexIcon = (props: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
)

// GitHub icon
export const GitHubIcon = (props: LucideProps) => (
  <svg viewBox="0 0 438.549 438.549" {...props}>
    <path
      fill="currentColor"
      d="M409.132 114.573c-19.608-33.596-46.205-60.194-79.798-79.8-33.598-19.607-70.277-29.408-110.063-29.408-39.781 0-76.472 9.804-110.063 29.408-33.596 19.605-60.192 46.204-79.8 79.8C9.803 148.168 0 184.854 0 224.63c0 47.78 13.94 90.745 41.827 128.906 27.884 38.164 63.906 64.572 108.063 79.227 5.14.954 8.945.283 11.419-1.996 2.475-2.282 3.711-5.14 3.711-8.562 0-.571-.049-5.708-.144-15.417a2549.81 2549.81 0 01-.144-25.406l-6.567 1.136c-4.187.767-9.469 1.092-15.846 1-6.374-.089-12.991-.757-19.842-1.999-6.854-1.231-13.229-4.086-19.13-8.559-5.898-4.473-10.085-10.328-12.56-17.556l-2.855-6.57c-1.903-4.374-4.899-9.233-8.992-14.559-4.093-5.331-8.232-8.945-12.419-10.848l-1.999-1.431c-1.332-.951-2.568-2.098-3.711-3.429-1.142-1.331-1.997-2.663-2.568-3.997-.572-1.335-.098-2.43 1.427-3.289 1.525-.859 4.281-1.276 8.28-1.276l5.708.853c3.807.763 8.516 3.042 14.133 6.851 5.614 3.806 10.229 8.754 13.846 14.9 4.38 7.806 9.657 13.754 15.846 17.847 6.184 4.093 12.419 6.136 18.699 6.136 6.28 0 11.704-.476 16.274-1.423 4.565-.952 8.848-2.383 12.847-4.285 1.713-12.758 6.377-22.559 13.988-29.41-10.848-1.14-20.601-2.857-29.264-5.14-8.658-2.286-17.605-5.996-26.835-11.14-9.235-5.137-16.896-11.516-22.985-19.126-6.09-7.614-11.088-17.61-14.987-29.979-3.901-12.374-5.852-26.648-5.852-42.826 0-23.035 7.52-42.637 22.557-58.817-7.044-17.318-6.379-36.732 1.997-58.24 5.52-1.715 13.706-.428 24.554 3.853 10.85 4.283 18.794 7.952 23.84 10.994 5.046 3.041 9.089 5.618 12.135 7.708 17.705-4.947 35.976-7.421 54.818-7.421s37.117 2.474 54.823 7.421l10.849-6.849c7.419-4.57 16.18-8.758 26.262-12.565 10.088-3.805 17.802-4.853 23.134-3.138 8.562 21.509 9.325 40.922 2.279 58.24 15.036 16.18 22.559 35.787 22.559 58.817 0 16.178-1.958 30.497-5.853 42.966-3.9 12.471-8.941 22.457-15.125 29.979-6.191 7.521-13.901 13.85-23.131 18.986-9.232 5.14-18.182 8.85-26.84 11.136-8.662 2.286-18.415 4.004-29.263 5.146 9.894 8.562 14.842 22.077 14.842 40.539v60.237c0 3.422 1.19 6.279 3.572 8.562 2.379 2.279 6.136 2.95 11.276 1.995 44.163-14.653 80.185-41.062 108.068-79.226 27.88-38.161 41.825-81.126 41.825-128.906-.01-39.771-9.818-76.454-29.414-110.049z"
    />
  </svg>
)

// Laptop icon for local mode
export function LaptopIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M4 6C4 4.89543 4.89543 4 6 4H18C19.1046 4 20 4.89543 20 6V15C20 15.5523 19.5523 16 19 16H5C4.44772 16 4 15.5523 4 15V6Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
      <path
        d="M2 16H22V18C22 19.1046 21.1046 20 20 20H4C2.89543 20 2 19.1046 2 18V16Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Skill icon - toolbox with tools
export function SkillIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M3 11H21V18C21 19.1046 20.1046 20 19 20H5C3.89543 20 3 19.1046 3 18V11Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 11V4C13 3.44772 13.4477 3 14 3H18C18.5523 3 19 3.44772 19 4V11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.0039 7H15.0039"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.00391 11V6.20156C5.00391 5.74742 5.15847 5.3068 5.44217 4.95217L6.69156 3.39043C6.88898 3.14366 7.18788 3 7.50391 3C7.81994 3 8.11883 3.14366 8.31625 3.39043L9.56564 4.95217C9.84934 5.3068 10.0039 5.74742 10.0039 6.20156V11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Brain icon filled - for Models tab
export function BrainFilledIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M11 2.10021C10.6766 2.03449 10.3421 2 10 2C7.89225 2 6.09097 3.30344 5.35484 5.14722C3.42387 5.65404 2 7.4102 2 9.5C2 10.4247 2.27964 11.2851 2.75796 12C2.27964 12.7149 2 13.5753 2 14.5C2 16.2118 2.95553 17.6984 4.35942 18.459C5.14867 20.5286 7.15137 22 9.5 22C10.0195 22 10.5228 21.9277 11 21.7927L11 17.0029L11 17C11 15.8954 10.1046 15 9 15C8.44772 15 8 14.5523 8 14C8 13.4477 8.44772 13 9 13C9.72858 13 10.4117 13.1948 11 13.5351L11 7L11 6.99766L11 2.10021Z"
        fill="currentColor"
      />
      <path
        d="M13 21.7927C13.4772 21.9277 13.9805 22 14.5 22C16.8486 22 18.8513 20.5286 19.6406 18.459C21.0445 17.6984 22 16.2118 22 14.5C22 13.5753 21.7204 12.7149 21.242 12C21.7204 11.2851 22 10.4247 22 9.5C22 7.4102 20.5761 5.65404 18.6452 5.14722C17.909 3.30344 16.1077 2 14 2C13.6579 2 13.3234 2.03449 13 2.10021L13 7.00329C13.0018 8.10635 13.8965 9 15 9C15.5523 9 16 9.44771 16 10C16 10.5523 15.5523 11 15 11C14.2714 11 13.5883 10.8052 13 10.4649L13 21.7927Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Flask icon filled - for Beta tab
export function FlaskFilledIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 7C7 6.44772 7.44772 6 8 6H16C16.5523 6 17 6.44772 17 7C17 7.55228 16.5523 8 16 8V10.6407C16.2119 10.8904 16.4506 11.1549 16.711 11.4408C16.7533 11.4872 16.7962 11.5342 16.8395 11.5817C17.1522 11.9244 17.4887 12.2933 17.8138 12.674C18.5455 13.531 19.3018 14.54 19.7032 15.6635C19.8862 16.1755 20 16.7228 20 17.2984C20 19.895 17.895 22 15.2984 22H8.70156C6.10496 22 4 19.895 4 17.2984C4 16.7228 4.11383 16.1755 4.29675 15.6635C4.69821 14.54 5.45453 13.531 6.18619 12.674C6.51126 12.2933 6.84777 11.9244 7.16044 11.5817C7.20378 11.5342 7.24665 11.4872 7.28897 11.4408C7.5494 11.1549 7.78811 10.8904 8 10.6407V8C7.44772 8 7 7.55228 7 7ZM10 8V11C10 11.2271 9.92272 11.4474 9.78087 11.6247C9.47431 12.0079 9.11903 12.4017 8.76744 12.7877C8.72393 12.8354 8.68042 12.8831 8.63695 12.9308C8.32229 13.2757 8.00937 13.6188 7.70721 13.9727C7.50789 14.2061 7.32002 14.4368 7.14694 14.6651C7.91001 14.5636 8.78427 14.4806 9.52666 14.5004C10.6623 14.5306 11.5266 14.8027 12.2733 15.0377L12.3001 15.0461C13.052 15.2827 13.6853 15.4779 14.5267 15.5004C15.2705 15.5202 16.2626 15.4072 17.1081 15.2782C17.1621 15.27 17.2152 15.2617 17.2674 15.2534C16.9969 14.8343 16.6648 14.4084 16.2928 13.9727C15.9906 13.6188 15.6777 13.2758 15.3631 12.9308C15.3196 12.8831 15.2761 12.8354 15.2326 12.7877C14.881 12.4017 14.5257 12.0079 14.2191 11.6247C14.0773 11.4474 14 11.2271 14 11V8H10Z"
        fill="currentColor"
      />
      <path
        d="M11 4C11 4.55228 10.5523 5 10 5C9.44772 5 9 4.55228 9 4C9 3.44772 9.44772 3 10 3C10.5523 3 11 3.44772 11 4Z"
        fill="currentColor"
      />
      <path
        d="M15 2.5C15 3.32843 14.3284 4 13.5 4C12.6716 4 12 3.32843 12 2.5C12 1.67157 12.6716 1 13.5 1C14.3284 1 15 1.67157 15 2.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Bug icon filled - for Debug tab
export function BugFilledIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.91667 5.68609C7.94791 5.75056 7.97843 5.81587 8.00825 5.88189C5.05927 7.26234 3.00047 10.1274 3.00047 13.5C3.00047 18.2542 7.09168 22 12.0005 22C16.9093 22 21.0005 18.2542 21.0005 13.5C21.0005 10.1268 18.9409 7.26129 15.9911 5.88114C16.0208 5.81537 16.0512 5.75032 16.0823 5.68609C16.6561 4.5021 17.2711 4 17.9228 4C18.3079 4 18.559 4.18838 18.7575 4.46211C18.8591 4.60212 18.9321 4.74822 18.9796 4.86188C19.0027 4.91731 19.0182 4.96129 19.027 4.98788C19.0314 5.00107 19.034 5.00997 19.035 5.01315C19.1792 5.54226 19.7234 5.85704 20.2547 5.71691C20.7888 5.57607 21.1075 5.02898 20.9666 4.49496L20.9662 4.49324L20.9657 4.49136L20.9645 4.48708L20.9616 4.47655L20.9534 4.44781C20.9468 4.42536 20.9379 4.39634 20.9264 4.36168C20.9037 4.29257 20.8705 4.19984 20.8251 4.0912C20.7356 3.87675 20.5923 3.58535 20.3765 3.28787C19.9404 2.68661 19.1531 2 17.9228 2C16.0361 2 14.9203 3.49789 14.2825 4.81387C14.216 4.95105 14.1525 5.09068 14.0918 5.23187C13.419 5.08015 12.7185 5 12.0005 5C11.2818 5 10.5807 5.08029 9.90732 5.23227C9.84657 5.09094 9.783 4.95118 9.71645 4.81387C9.0787 3.49789 7.96289 2 6.07619 2C4.84592 2 4.05854 2.68661 3.62246 3.28787C3.4067 3.58535 3.2634 3.87675 3.17385 4.0912C3.12848 4.19984 3.09532 4.29257 3.07254 4.36168C3.06111 4.39634 3.05219 4.42536 3.04558 4.44781L3.03734 4.47655L3.03444 4.48708L3.03329 4.49136L3.03279 4.49324L3.03233 4.49496C2.89149 5.02898 3.21023 5.57607 3.74425 5.71691C4.27555 5.85704 4.81978 5.54226 4.96402 5.01315C4.96495 5.00997 4.96763 5.00107 4.97198 4.98788C4.98074 4.96129 4.99625 4.91731 5.0194 4.86188C5.06686 4.74822 5.13991 4.60212 5.24146 4.46211C5.43999 4.18838 5.69108 4 6.07619 4C6.72792 4 7.34287 4.5021 7.91667 5.68609ZM10.5 13.75C10.5 14.7165 9.82843 15.5 9 15.5C8.17157 15.5 7.5 14.7165 7.5 13.75C7.5 12.7835 8.17157 12 9 12C9.82843 12 10.5 12.7835 10.5 13.75ZM13.5 17C13.5 17.5523 12.8284 18 12 18C11.1716 18 10.5 17.5523 10.5 17C10.5 16.4477 11.1716 16 12 16C12.8284 16 13.5 16.4477 13.5 17ZM15 15.5C15.8284 15.5 16.5 14.7165 16.5 13.75C16.5 12.7835 15.8284 12 15 12C14.1716 12 13.5 12.7835 13.5 13.75C13.5 14.7165 14.1716 15.5 15 15.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Skill icon filled - toolbox with tools (filled version)
export function SkillIconFilled(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.0039 10V6.20156C11.0039 5.52035 10.7721 4.85942 10.3465 4.32748L9.09712 2.76574C8.70993 2.28175 8.12372 2 7.50391 2C6.88409 2 6.29788 2.28175 5.91069 2.76574L4.6613 4.32748C4.23575 4.85942 4.00391 5.52035 4.00391 6.20156V10H3C2.44772 10 2 10.4477 2 11V18C2 19.6569 3.34315 21 5 21H19C20.6569 21 22 19.6569 22 18V11C22 10.4477 21.5523 10 21 10H20V4C20 2.89543 19.1046 2 18 2H14C12.8954 2 12 2.89543 12 4V10H11.0039ZM7.50391 4C7.49166 4 7.48008 4.00557 7.47243 4.01513L6.22304 5.57687C6.08119 5.75418 6.00391 5.97449 6.00391 6.20156V10H9.00391V6.20156C9.00391 5.97449 8.92663 5.75418 8.78477 5.57687L7.53539 4.01513C7.52773 4.00557 7.51615 4 7.50391 4ZM14 10H18V4H14V6H15.0039C15.5562 6 16.0039 6.44772 16.0039 7C16.0039 7.55228 15.5562 8 15.0039 8H14V10Z"
        fill="currentColor"
      />
    </svg>
  )
}

// Review icon - checklist with checkmarks and magnifying glass
export function IconReview(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M7.54295 9.49777L8.66795 10.2478L10.5396 7.75226M14.0579 9.00002H16.0579M7.54295 15.4989L8.66795 16.2489L10.5396 13.7534M10 20H6C4.89543 20 4 19.1046 4 18V6C4 4.89543 4.89543 4 6 4H18C19.1046 4 20 4.89543 20 6V10M19.1213 19.1213C17.9497 20.2929 16.0503 20.2929 14.8787 19.1213C13.7071 17.9497 13.7071 16.0502 14.8787 14.8786C16.0503 13.7071 17.9497 13.7071 19.1213 14.8786C20.2929 16.0502 20.2929 17.9497 19.1213 19.1213ZM19.1213 19.1213L21 21"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function KeyFilledIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      width="24"
      height="24"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M22 8.5C22 12.0899 19.0899 15 15.5 15C14.7504 15 14.0304 14.8731 13.3604 14.6396L11.5858 16.4142C11.2107 16.7893 10.702 17 10.1716 17H9.5C9.22386 17 9 17.2239 9 17.5V18.1716C9 18.702 8.78929 19.2107 8.41421 19.5858L7.87868 20.1213C7.31607 20.6839 6.55301 21 5.75736 21H4C3.44772 21 3 20.5523 3 20V18.2426C3 17.447 3.31607 16.6839 3.87868 16.1213L9.36037 10.6396C9.12689 9.96959 9 9.24962 9 8.5C9 4.91015 11.9101 2 15.5 2C19.0899 2 22 4.91015 22 8.5ZM17 8.5C17 9.32843 16.3284 10 15.5 10C14.6716 10 14 9.32843 14 8.5C14 7.67157 14.6716 7 15.5 7C16.3284 7 17 7.67157 17 8.5Z"
      />
    </svg>
  )
}

export function SettingsFilledIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      width="24"
      height="24"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9.78522 3.18531C10.2789 2.44479 11.11 2 12 2C12.89 2 13.7211 2.44479 14.2148 3.18531L14.771 4.01958C14.9961 4.35724 15.4067 4.52029 15.8021 4.42904L16.4882 4.2707C17.3962 4.06117 18.348 4.33416 19.0069 4.99307C19.6658 5.65197 19.9388 6.60383 19.7293 7.5118L19.571 8.19791C19.4797 8.59333 19.6428 9.00394 19.9804 9.22904L20.8147 9.78522C21.5552 10.2789 22 11.11 22 12C22 12.89 21.5552 13.7211 20.8147 14.2148L19.9804 14.771C19.6428 14.9961 19.4797 15.4067 19.571 15.8021L19.7293 16.4882C19.9388 17.3962 19.6658 18.348 19.0069 19.0069C18.348 19.6658 17.3962 19.9388 16.4882 19.7293L15.8021 19.571C15.4067 19.4797 14.9961 19.6428 14.771 19.9804L14.2148 20.8147C13.7211 21.5552 12.89 22 12 22C11.11 22 10.2789 21.5552 9.78522 20.8147L9.22904 19.9804C9.00394 19.6428 8.59333 19.4797 8.19791 19.571L7.5118 19.7293C6.60383 19.9388 5.65197 19.6658 4.99307 19.0069C4.33416 18.348 4.06117 17.3962 4.2707 16.4882L4.42904 15.8021C4.52029 15.4067 4.35724 14.9961 4.01958 14.771L3.18531 14.2148C2.44479 13.7211 2 12.89 2 12C2 11.11 2.4448 10.2789 3.18531 9.78522L4.01958 9.22904C4.35724 9.00394 4.52029 8.59333 4.42904 8.19791L4.2707 7.5118C4.06117 6.60383 4.33416 5.65197 4.99307 4.99307C5.65197 4.33416 6.60383 4.06117 7.5118 4.2707L8.19791 4.42904C8.59333 4.52029 9.00394 4.35724 9.22904 4.01958L9.78522 3.18531ZM8.5 12C8.5 10.067 10.067 8.5 12 8.5C13.933 8.5 15.5 10.067 15.5 12C15.5 13.933 13.933 15.5 12 15.5C10.067 15.5 8.5 13.933 8.5 12Z"
      />
    </svg>
  )
}

// Diff view display mode icons
export function IconSidePeek(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.72505 3H14.2749C15.4129 2.99999 16.3307 2.99998 17.074 3.06071C17.8394 3.12324 18.5116 3.25534 19.1335 3.57222C20.1213 4.07555 20.9245 4.8787 21.4277 5.86655C21.7446 6.48846 21.8767 7.16066 21.9393 7.92595C22 8.66921 22 9.58706 22 10.7251V14.1749C22 15.3129 22 16.2308 21.9393 16.974C21.8767 17.7394 21.7446 18.4116 21.4277 19.0335C20.9245 20.0213 20.1213 20.8245 19.1335 21.3277C18.5116 21.6446 17.8394 21.7767 17.074 21.8393C16.3308 21.9 15.4129 21.9 14.2749 21.9H8.72503C7.58706 21.9 6.66921 21.9 5.92595 21.8393C5.16066 21.7767 4.48846 21.6446 3.86655 21.3277C2.8787 20.8245 2.07555 20.0213 1.57222 19.0335C1.25534 18.4116 1.12324 17.7394 1.06071 16.974C0.999979 16.2307 0.99999 15.3129 1 14.1749V10.7251C0.99999 9.58708 0.999979 8.66922 1.06071 7.92595C1.12324 7.16066 1.25534 6.48846 1.57222 5.86655C2.07555 4.8787 2.8787 4.07555 3.86655 3.57222C4.48846 3.25534 5.16066 3.12324 5.92595 3.06071C6.66922 2.99998 7.58708 2.99999 8.72505 3ZM6.09695 5.15374C5.46152 5.20565 5.09645 5.30243 4.81993 5.44333C4.22722 5.74533 3.74533 6.22722 3.44333 6.81993C3.30243 7.09645 3.20565 7.46152 3.15374 8.09695C3.10082 8.74463 3.1 9.57656 3.1 10.77V14.13C3.1 15.3234 3.10082 16.1553 3.15374 16.8031C3.20565 17.4384 3.30243 17.8035 3.44333 18.0801C3.74533 18.6728 4.22722 19.1547 4.81993 19.4566C5.09645 19.5976 5.46152 19.6944 6.09695 19.7462C6.74463 19.7992 7.57656 19.8 8.77 19.8H14.23C15.4234 19.8 16.2553 19.7992 16.9031 19.7462C17.5384 19.6944 17.9035 19.5976 18.1801 19.4566C18.7728 19.1547 19.2547 18.6728 19.5566 18.0801C19.6976 17.8035 19.7944 17.4384 19.8462 16.8031C19.8992 16.1553 19.9 15.3234 19.9 14.13V10.77C19.9 9.57656 19.8992 8.74463 19.8462 8.09695C19.7944 7.46152 19.6976 7.09645 19.5566 6.81993C19.2547 6.22722 18.7728 5.74533 18.1801 5.44333C17.9035 5.30243 17.5384 5.20565 16.9031 5.15374C16.2553 5.10082 15.4234 5.1 14.23 5.1H8.77C7.57656 5.1 6.74463 5.10082 6.09695 5.15374ZM10.45 7.2C11.0299 7.2 11.5 7.67011 11.5 8.25V16.65C11.5 17.2299 11.0299 17.7 10.45 17.7C9.87008 17.7 9.4 17.2299 9.4 16.65V8.25C9.4 7.67011 9.87008 7.2 10.45 7.2Z" />
      <path d="M17.7992 8.2502C17.7992 7.6703 17.3291 7.2002 16.7492 7.2002C16.1693 7.2002 15.6992 7.6703 15.6992 8.2502V16.6502C15.6992 17.2301 16.1693 17.7002 16.7492 17.7002C17.3291 17.7002 17.7992 17.2301 17.7992 16.6502V8.2502Z" />
      <path d="M10.4492 7.2002H16.7492V17.7002H10.4492V7.2002Z" />
    </svg>
  )
}

export function IconCenterPeek(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.72505 3H14.2749C15.4129 2.99999 16.3307 2.99998 17.074 3.06071C17.8394 3.12324 18.5116 3.25534 19.1335 3.57222C20.1213 4.07555 20.9245 4.8787 21.4278 5.86655C21.7446 6.48846 21.8767 7.16066 21.9393 7.92595C22 8.66921 22 9.58706 22 10.7251V14.1749C22 15.3129 22 16.2308 21.9393 16.974C21.8767 17.7394 21.7446 18.4116 21.4278 19.0335C20.9245 20.0213 20.1213 20.8245 19.1335 21.3277C18.5116 21.6446 17.8394 21.7767 17.074 21.8393C16.3308 21.9 15.4129 21.9 14.2749 21.9H8.72503C7.58706 21.9 6.66921 21.9 5.92595 21.8393C5.16066 21.7767 4.48846 21.6446 3.86655 21.3277C2.8787 20.8245 2.07555 20.0213 1.57222 19.0335C1.25534 18.4116 1.12324 17.7394 1.06071 16.974C0.999979 16.2307 0.99999 15.3129 1 14.1749V10.7251C0.99999 9.58708 0.999979 8.66922 1.06071 7.92595C1.12324 7.16066 1.25534 6.48846 1.57222 5.86655C2.07555 4.8787 2.8787 4.07555 3.86655 3.57222C4.48846 3.25534 5.16066 3.12324 5.92595 3.06071C6.66922 2.99998 7.58708 2.99999 8.72505 3ZM6.09695 5.15374C5.46152 5.20565 5.09645 5.30243 4.81993 5.44333C4.22722 5.74533 3.74533 6.22722 3.44333 6.81993C3.30243 7.09645 3.20565 7.46152 3.15374 8.09695C3.10082 8.74463 3.1 9.57656 3.1 10.77V14.13C3.1 15.3234 3.10082 16.1553 3.15374 16.8031C3.20565 17.4384 3.30243 17.8035 3.44333 18.0801C3.74533 18.6728 4.22722 19.1547 4.81993 19.4566C5.09645 19.5976 5.46152 19.6944 6.09695 19.7462C6.74464 19.7992 7.57656 19.8 8.77 19.8H14.23C15.4234 19.8 16.2553 19.7992 16.9031 19.7462C17.5384 19.6944 17.9035 19.5976 18.1801 19.4566C18.7728 19.1547 19.2547 18.6728 19.5567 18.0801C19.6976 17.8035 19.7944 17.4384 19.8462 16.8031C19.8992 16.1553 19.9 15.3234 19.9 14.13V10.77C19.9 9.57656 19.8992 8.74463 19.8462 8.09695C19.7944 7.46152 19.6976 7.09645 19.5567 6.81993C19.2547 6.22722 18.7728 5.74533 18.1801 5.44333C17.9035 5.30243 17.5384 5.20565 16.9031 5.15374C16.2553 5.10082 15.4234 5.1 14.23 5.1H8.77C7.57656 5.1 6.74464 5.10082 6.09695 5.15374ZM10.45 7.2C11.0299 7.2 11.5 7.67011 11.5 8.25V16.65C11.5 17.2299 11.0299 17.7 10.45 17.7C9.87009 17.7 9.4 17.2299 9.4 16.65V8.25C9.4 7.67011 9.87009 7.2 10.45 7.2Z" />
      <path d="M17.7992 8.2502C17.7992 7.6703 17.3291 7.2002 16.7492 7.2002C16.1693 7.2002 15.6992 7.6703 15.6992 8.2502V16.6502C15.6992 17.2301 16.1693 17.7002 16.7492 17.7002C17.3291 17.7002 17.7992 17.2301 17.7992 16.6502V8.2502Z" />
      <path d="M7.57461 8.2502C7.57461 7.6703 7.10452 7.2002 6.52461 7.2002C5.94469 7.2002 5.47461 7.6703 5.47461 8.2502V16.6502C5.47461 17.2301 5.94469 17.7002 6.52461 17.7002C7.10452 17.7002 7.57461 17.2301 7.57461 16.6502V8.2502Z" />
      <path d="M6.47461 7.19881L16.7787 7.19896V17.6915H6.47461V7.19881Z" />
    </svg>
  )
}

export function IconFullPage(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.72505 3H14.2749C15.4129 2.99999 16.3307 2.99998 17.074 3.06071C17.8394 3.12324 18.5116 3.25534 19.1335 3.57222C20.1213 4.07555 20.9245 4.8787 21.4278 5.86655C21.7446 6.48846 21.8767 7.16066 21.9393 7.92595C22 8.66921 22 9.58706 22 10.7251V14.1749C22 15.3129 22 16.2308 21.9393 16.974C21.8767 17.7394 21.7446 18.4116 21.4278 19.0335C20.9245 20.0213 20.1213 20.8245 19.1335 21.3277C18.5116 21.6446 17.8394 21.7767 17.074 21.8393C16.3308 21.9 15.4129 21.9 14.2749 21.9H8.72503C7.58706 21.9 6.66921 21.9 5.92595 21.8393C5.16066 21.7767 4.48846 21.6446 3.86655 21.3277C2.8787 20.8245 2.07555 20.0213 1.57222 19.0335C1.25534 18.4116 1.12324 17.7394 1.06071 16.974C0.999979 16.2307 0.99999 15.3129 1 14.1749V10.7251C0.99999 9.58708 0.999979 8.66922 1.06071 7.92595C1.12324 7.16066 1.25534 6.48846 1.57222 5.86655C2.07555 4.8787 2.8787 4.07555 3.86655 3.57222C4.48846 3.25534 5.16066 3.12324 5.92595 3.06071C6.66922 2.99998 7.58708 2.99999 8.72505 3ZM6.09695 5.15374C5.46152 5.20565 5.09645 5.30243 4.81993 5.44333C4.22722 5.74533 3.74533 6.22722 3.44333 6.81993C3.30243 7.09645 3.20565 7.46152 3.15374 8.09695C3.10082 8.74463 3.1 9.57656 3.1 10.77V14.13C3.1 15.3234 3.10082 16.1553 3.15374 16.8031C3.20565 17.4384 3.30243 17.8035 3.44333 18.0801C3.74533 18.6728 4.22722 19.1547 4.81993 19.4566C5.09645 19.5976 5.46152 19.6944 6.09695 19.7462C6.74464 19.7992 7.57656 19.8 8.77 19.8H14.23C15.4234 19.8 16.2553 19.7992 16.9031 19.7462C17.5384 19.6944 17.9035 19.5976 18.1801 19.4566C18.7728 19.1547 19.2547 18.6728 19.5567 18.0801C19.6976 17.8035 19.7944 17.4384 19.8462 16.8031C19.8992 16.1553 19.9 15.3234 19.9 14.13V10.77C19.9 9.57656 19.8992 8.74463 19.8462 8.09695C19.7944 7.46152 19.6976 7.09645 19.5567 6.81993C19.2547 6.22722 18.7728 5.74533 18.1801 5.44333C17.9035 5.30243 17.5384 5.20565 16.9031 5.15374C16.2553 5.10082 15.4234 5.1 14.23 5.1H8.77C7.57656 5.1 6.74464 5.10082 6.09695 5.15374ZM10.45 7.2C11.0299 7.2 11.5 7.67011 11.5 8.25V16.65C11.5 17.2299 11.0299 17.7 10.45 17.7C9.87009 17.7 9.4 17.2299 9.4 16.65V8.25C9.4 7.67011 9.87009 7.2 10.45 7.2Z" />
      <path d="M4 8.5C4 7.11929 5.11929 6 6.5 6H16.5C17.8807 6 19 7.11929 19 8.5V16.5C19 17.8807 17.8807 19 16.5 19H6.5C5.11929 19 4 17.8807 4 16.5V8.5Z" />
    </svg>
  )
}

export function IconBottomPanel(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.72505 3H14.2749C15.4129 2.99999 16.3307 2.99998 17.074 3.06071C17.8394 3.12324 18.5116 3.25534 19.1335 3.57222C20.1213 4.07555 20.9245 4.8787 21.4278 5.86655C21.7446 6.48846 21.8767 7.16066 21.9393 7.92595C22 8.66921 22 9.58706 22 10.7251V14.1749C22 15.3129 22 16.2308 21.9393 16.974C21.8767 17.7394 21.7446 18.4116 21.4278 19.0335C20.9245 20.0213 20.1213 20.8245 19.1335 21.3277C18.5116 21.6446 17.8394 21.7767 17.074 21.8393C16.3308 21.9 15.4129 21.9 14.2749 21.9H8.72503C7.58706 21.9 6.66921 21.9 5.92595 21.8393C5.16066 21.7767 4.48846 21.6446 3.86655 21.3277C2.8787 20.8245 2.07555 20.0213 1.57222 19.0335C1.25534 18.4116 1.12324 17.7394 1.06071 16.974C0.999979 16.2307 0.99999 15.3129 1 14.1749V10.7251C0.99999 9.58708 0.999979 8.66922 1.06071 7.92595C1.12324 7.16066 1.25534 6.48846 1.57222 5.86655C2.07555 4.8787 2.8787 4.07555 3.86655 3.57222C4.48846 3.25534 5.16066 3.12324 5.92595 3.06071C6.66922 2.99998 7.58708 2.99999 8.72505 3ZM6.09695 5.15374C5.46152 5.20565 5.09645 5.30243 4.81993 5.44333C4.22722 5.74533 3.74533 6.22722 3.44333 6.81993C3.30243 7.09645 3.20565 7.46152 3.15374 8.09695C3.10082 8.74463 3.1 9.57656 3.1 10.77V14.13C3.1 15.3234 3.10082 16.1553 3.15374 16.8031C3.20565 17.4384 3.30243 17.8035 3.44333 18.0801C3.74533 18.6728 4.22722 19.1547 4.81993 19.4566C5.09645 19.5976 5.46152 19.6944 6.09695 19.7462C6.74464 19.7992 7.57656 19.8 8.77 19.8H14.23C15.4234 19.8 16.2553 19.7992 16.9031 19.7462C17.5384 19.6944 17.9035 19.5976 18.1801 19.4566C18.7728 19.1547 19.2547 18.6728 19.5567 18.0801C19.6976 17.8035 19.7944 17.4384 19.8462 16.8031C19.8992 16.1553 19.9 15.3234 19.9 14.13V10.77C19.9 9.57656 19.8992 8.74463 19.8462 8.09695C19.7944 7.46152 19.6976 7.09645 19.5567 6.81993C19.2547 6.22722 18.7728 5.74533 18.1801 5.44333C17.9035 5.30243 17.5384 5.20565 16.9031 5.15374C16.2553 5.10082 15.4234 5.1 14.23 5.1H8.77C7.57656 5.1 6.74464 5.10082 6.09695 5.15374Z" />
      <path d="M16.7783 11.501C17.3447 11.5164 17.7987 11.9797 17.7988 12.5498V16.6504C17.7987 17.2302 17.3289 17.7002 16.749 17.7002C16.706 17.7002 16.6637 17.6964 16.6221 17.6914H6.65625C6.6131 17.6968 6.56903 17.7002 6.52441 17.7002C5.94462 17.7001 5.47466 17.2302 5.47461 16.6504V12.5498C5.47471 11.9868 5.91799 11.5281 6.47461 11.502V11.5H16.7783V11.501Z" />
    </svg>
  )
}

export function IconLineNumbers(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="24" height="24" {...props}>
      <path d="M12 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 9.5V4.5L4 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.25 15C4.25 15 4.9 14.5 5.61102 14.5C6.37813 14.5 7 15.1219 7 15.889C7 17.6885 4 18 4 19.5H7.25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function AIPenIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <g transform="scale(1.1) translate(-1.2, -1.2)">
        <path
          d="M19.4142 5.9144L20.0858 6.58597C20.8668 7.36702 20.8668 8.63335 20.0858 9.4144L10.4852 19.015C10.1707 19.3294 9.7604 19.5301 9.31908 19.5853L6 20.0002L6.41489 16.6811C6.47005 16.2398 6.67074 15.8294 6.98523 15.515L16.5858 5.9144C17.3668 5.13335 18.6332 5.13335 19.4142 5.9144Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7.24045 4.18518L6.54359 2.37334C6.45708 2.14842 6.24099 2 6 2C5.75901 2 5.54292 2.14842 5.45641 2.37334L4.75955 4.18518C4.65797 4.44927 4.44927 4.65797 4.18518 4.75955L2.37334 5.45641C2.14842 5.54292 2 5.75901 2 6C2 6.24099 2.14842 6.45708 2.37334 6.54359L4.18518 7.24045C4.44927 7.34203 4.65797 7.55073 4.75955 7.81482L5.45641 9.62666C5.54292 9.85158 5.75901 10 6 10C6.24099 10 6.45708 9.85158 6.54359 9.62666L7.24045 7.81482C7.34203 7.55073 7.55073 7.34203 7.81482 7.24045L9.62666 6.54359C9.85158 6.45708 10 6.24099 10 6C10 5.75901 9.85158 5.54292 9.62666 5.45641L7.81482 4.75955C7.55073 4.65797 7.34203 4.44927 7.24045 4.18518Z"
          fill="currentColor"
        />
        <path
          d="M15 8L18 11"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}

export function ThinkingIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M5.94 4.91257L8.2012 3.49932C8.70708 3.18315 9.3277 3.1093 9.89365 3.29795L11.3675 3.78925C11.7781 3.9261 12.2219 3.9261 12.6325 3.78925L14.1064 3.29795C14.6723 3.1093 15.2929 3.18314 15.7988 3.49932L18.06 4.91257C18.6448 5.27805 19 5.91899 19 6.60857V7.00007C19 7.62958 19.2964 8.22236 19.8 8.60007L20.2 8.90007C20.7036 9.27778 21 9.87056 21 10.5001V12.5001C21 13.1296 20.7036 13.7224 20.2 14.1001L19.8 14.4001C19.2964 14.7778 19 15.3706 19 16.0001V17.3916C19 18.0812 18.6448 18.7221 18.06 19.0876L15.7988 20.5008C15.2929 20.817 14.6723 20.8908 14.1064 20.7022L12.6325 20.2109C12.2219 20.074 11.7781 20.074 11.3675 20.2109L9.89365 20.7022C9.3277 20.8908 8.70708 20.817 8.2012 20.5008L5.94 19.0876C5.35524 18.7221 5 18.0812 5 17.3916V16.0001C5 15.3706 4.70361 14.7778 4.2 14.4001L3.8 14.1001C3.29639 13.7224 3 13.1296 3 12.5001V10.5001C3 9.87056 3.29639 9.27778 3.8 8.90007L4.2 8.60007C4.70361 8.22236 5 7.62958 5 7.00007V6.60857C5 5.91899 5.35524 5.27805 5.94 4.91257Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 4.5V7.17157C12 7.70201 12.2107 8.21071 12.5858 8.58579L15 11"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 19.5V16.8284C12 16.298 11.7893 15.7893 11.4142 15.4142L9 13"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="9"
        cy="13"
        r="1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="15"
        cy="11"
        r="1"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function MicrophoneIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      width="24"
      height="24"
      {...props}
    >
      <path d="M12.7891 1.6001C10.5799 1.6001 8.78906 3.83868 8.78906 6.6001V10.6001C8.78906 13.3615 10.5799 15.6001 12.7891 15.6001C14.9982 15.6001 16.7891 13.3615 16.7891 10.6001V6.6001C16.7891 3.83868 14.9982 1.6001 12.7891 1.6001Z" />
      <path d="M7.87156 14.0558C7.63105 13.5926 7.13562 13.4607 6.76499 13.7614C6.39436 14.062 6.28889 14.6813 6.52941 15.1446C7.42831 16.876 9.14619 19.1786 11.989 19.549V20.6002C11.989 21.1525 12.3472 21.6002 12.789 21.6002C13.2309 21.6002 13.589 21.1525 13.589 20.6002V19.549C16.4319 19.1786 18.1497 16.876 19.0486 15.1446C19.2892 14.6813 19.1837 14.062 18.813 13.7614C18.4425 13.4607 17.947 13.5926 17.7064 14.0558C16.8748 15.6578 15.3491 17.6002 12.789 17.6002C10.2289 17.6002 8.70325 15.6578 7.87156 14.0558Z" />
    </svg>
  )
}

export function CloudIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M7 19C4.23858 19 2 16.7614 2 14C2 11.4673 3.88316 9.37436 6.32568 9.04508C7.13649 6.69118 9.37075 5 12 5C15.3137 5 18 7.68629 18 11C20.2091 11 22 12.7909 22 15C22 17.2091 20.2091 19 18 19H7Z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Plugin icon filled - puzzle piece for Plugins tab
export function PluginFilledIcon(props: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width="24"
      height="24"
      {...props}
    >
      <path
        d="M10 3C10 2.44772 9.55228 2 9 2C8.44772 2 8 2.44772 8 3V6H7C5.34315 6 4 7.34315 4 9V14C4 16.7614 6.23858 19 9 19H11V21C11 21.5523 11.4477 22 12 22C12.5523 22 13 21.5523 13 21V19H15C17.7614 19 20 16.7614 20 14V9C20 7.34315 18.6569 6 17 6H16V3C16 2.44772 15.5523 2 15 2C14.4477 2 14 2.44772 14 3V6H10V3Z"
        fill="currentColor"
      />
    </svg>
  )
}
