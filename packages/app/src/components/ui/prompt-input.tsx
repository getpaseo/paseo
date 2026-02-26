import { Textarea } from "./textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./tooltip"
import { cn } from "@/lib/cn"
import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useLayoutEffect,
  useEffect,
  forwardRef,
} from "react"

type PromptInputContextType = {
  isLoading: boolean
  value: string
  setValue: (_value: string) => void
  maxHeight: number | string
  onSubmit?: () => void
  disabled?: boolean
}

const PromptInputContext = createContext<PromptInputContextType>({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
})

function usePromptInput() {
  const context = useContext(PromptInputContext)
  if (!context) {
    throw new Error("usePromptInput must be used within a PromptInput")
  }
  return context
}

type PromptInputProps = {
  isLoading?: boolean
  value?: string
  onValueChange?: (_value: string) => void
  maxHeight?: number | string
  onSubmit?: () => void
  children: React.ReactNode
  className?: string
  disabled?: boolean
}

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled,
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "")

  const handleChange = (newValue: string) => {
    setInternalValue(newValue)
    onValueChange?.(newValue)
  }

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        maxHeight,
        onSubmit,
        disabled,
      }}
    >
      <div className={cn("flex flex-col gap-2", className)}>{children}</div>
    </PromptInputContext.Provider>
  )
}

export type PromptInputTextareaProps = {
  disableAutosize?: boolean
} & React.ComponentProps<typeof Textarea>

const PromptInputTextareaInner = (
  {
    className,
    onKeyDown,
    disableAutosize = false,
    ...props
  }: PromptInputTextareaProps,
  forwardedRef: React.Ref<HTMLTextAreaElement>,
) => {
  const { value, setValue, maxHeight, onSubmit, disabled } = usePromptInput()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!forwardedRef) return
    if (typeof forwardedRef === "function") {
      forwardedRef(textareaRef.current)
    } else if (forwardedRef) {
      ;(
        forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>
      ).current = textareaRef.current
    }
  }, [forwardedRef])

  useLayoutEffect(() => {
    if (disableAutosize || !textareaRef.current) return

    const textarea = textareaRef.current
    textarea.style.height = "auto"

    const scrollHeight = textarea.scrollHeight
    const maxHeightPx =
      typeof maxHeight === "number"
        ? maxHeight
        : parseInt(maxHeight as string, 10) || 240

    const newHeight = Math.min(scrollHeight, maxHeightPx)
    textarea.style.height = `${newHeight}px`
    textarea.style.overflowY = scrollHeight > maxHeightPx ? "auto" : "hidden"
  }, [value, disableAutosize, maxHeight])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault()
      onSubmit?.()
    }
    onKeyDown?.(e)
  }

  const maxHeightStyle =
    typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight

  return (
    <Textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      className={cn(
        "min-h-[44px] w-full resize-none border-none bg-transparent shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className,
      )}
      style={{
        maxHeight: maxHeightStyle,
        overflowY: "hidden",
      }}
      rows={1}
      disabled={disabled}
      {...props}
    />
  )
}

const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  PromptInputTextareaProps
>(PromptInputTextareaInner)

PromptInputTextarea.displayName = "PromptInputTextarea"

type PromptInputActionsProps = React.HTMLAttributes<HTMLDivElement>

function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      {children}
    </div>
  )
}

type PromptInputActionProps = {
  className?: string
  tooltip: React.ReactNode
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
} & React.ComponentProps<typeof Tooltip>

function PromptInputAction({
  tooltip,
  children,
  className,
  side = "top",
  ...props
}: PromptInputActionProps) {
  const { disabled } = usePromptInput()

  return (
    <Tooltip {...props}>
      <TooltipTrigger asChild disabled={disabled}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
  usePromptInput,
}
