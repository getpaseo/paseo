import * as React from "react"
import { cn } from "@/lib/cn"
import { SearchIcon } from "./icons"
import {
  overlayItem,
  overlaySeparator,
} from "@/lib/overlay-styles"

// Context for keyboard navigation
interface CommandContextValue {
  selectedValue: string | null
  setSelectedValue: (value: string | null) => void
  onSelect: (value: string) => void
  registerItem: (value: string, element: HTMLDivElement | null) => void
  getItems: () => Map<string, HTMLDivElement>
}

const CommandContext = React.createContext<CommandContextValue | null>(null)

interface CommandProps extends React.HTMLAttributes<HTMLDivElement> {
  shouldFilter?: boolean
  value?: string
  onValueChange?: (value: string) => void
}

const Command = React.forwardRef<HTMLDivElement, CommandProps>(
  ({ className, shouldFilter, value, onValueChange, children, ...props }, ref) => {
    const [selectedValue, setSelectedValue] = React.useState<string | null>(null)
    const itemsRef = React.useRef<Map<string, HTMLDivElement>>(new Map())
    const orderedKeysRef = React.useRef<string[]>([])

    const registerItem = React.useCallback(
      (value: string, element: HTMLDivElement | null) => {
        if (element) {
          itemsRef.current.set(value, element)
          // Keep track of order based on registration
          if (!orderedKeysRef.current.includes(value)) {
            orderedKeysRef.current.push(value)
          }
        } else {
          itemsRef.current.delete(value)
          orderedKeysRef.current = orderedKeysRef.current.filter(k => k !== value)
        }
      },
      [],
    )

    const getItems = React.useCallback(() => itemsRef.current, [])

    const onSelect = React.useCallback((value: string) => {
      const element = itemsRef.current.get(value)
      if (element) {
        element.click()
      }
    }, [])

    // Reset selection when items change
    React.useEffect(() => {
      const keys = orderedKeysRef.current
      if (keys.length > 0 && !keys.includes(selectedValue || "")) {
        setSelectedValue(keys[0] || null)
      }
    })

    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent) => {
        const keys = orderedKeysRef.current
        const currentIndex = selectedValue ? keys.indexOf(selectedValue) : -1

        switch (e.key) {
          case "ArrowDown":
            e.preventDefault()
            if (keys.length > 0) {
              const nextIndex = currentIndex + 1 >= keys.length ? 0 : currentIndex + 1
              const nextKey = keys[nextIndex]
              setSelectedValue(nextKey!)
              itemsRef.current.get(nextKey!)?.scrollIntoView({ block: "nearest" })
            }
            break
          case "ArrowUp":
            e.preventDefault()
            if (keys.length > 0) {
              const prevIndex = currentIndex - 1 < 0 ? keys.length - 1 : currentIndex - 1
              const prevKey = keys[prevIndex]
              setSelectedValue(prevKey!)
              itemsRef.current.get(prevKey!)?.scrollIntoView({ block: "nearest" })
            }
            break
          case "Enter":
            e.preventDefault()
            if (selectedValue) {
              onSelect(selectedValue)
            }
            break
          case "Home":
            e.preventDefault()
            if (keys.length > 0) {
              setSelectedValue(keys[0]!)
              itemsRef.current.get(keys[0]!)?.scrollIntoView({ block: "nearest" })
            }
            break
          case "End":
            e.preventDefault()
            if (keys.length > 0) {
              const lastKey = keys[keys.length - 1]
              setSelectedValue(lastKey!)
              itemsRef.current.get(lastKey!)?.scrollIntoView({ block: "nearest" })
            }
            break
        }
      },
      [selectedValue, onSelect],
    )

    const contextValue = React.useMemo(
      () => ({
        selectedValue,
        setSelectedValue,
        onSelect,
        registerItem,
        getItems,
      }),
      [selectedValue, onSelect, registerItem, getItems],
    )

    return (
      <CommandContext.Provider value={contextValue}>
        <div
          ref={ref}
          className={cn(
            "flex h-full w-full flex-col overflow-hidden text-popover-foreground",
            className,
          )}
          onKeyDown={handleKeyDown}
          {...props}
        >
          {children}
        </div>
      </CommandContext.Provider>
    )
  },
)
Command.displayName = "Command"

interface CommandInputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  onValueChange?: (value: string) => void
  wrapperClassName?: string
}

const CommandInput = React.forwardRef<HTMLInputElement, CommandInputProps>(
  ({ className, onValueChange, wrapperClassName, onChange, ...props }, ref) => {
    const localRef = React.useRef<HTMLInputElement>(null)
    const inputRef = (ref as React.RefObject<HTMLInputElement>) || localRef

    // Auto-focus input when mounted
    React.useEffect(() => {
      // Small delay to ensure popover is rendered
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => clearTimeout(timer)
    }, [])

    return (
      <div
        className={cn(
          "flex items-center gap-1.5 h-7 px-1.5 mx-1 my-1 rounded-md bg-muted/50",
          wrapperClassName,
        )}
        cmdk-input-wrapper=""
      >
        <SearchIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          className={cn(
            "flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          onChange={(e) => {
            onChange?.(e)
            onValueChange?.(e.target.value)
          }}
          {...props}
        />
      </div>
    )
  },
)
CommandInput.displayName = "CommandInput"

const CommandList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden py-1", className)}
    {...props}
  />
))
CommandList.displayName = "CommandList"

const CommandEmpty = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("py-6 text-center text-sm text-muted-foreground", className)}
    {...props}
  />
))
CommandEmpty.displayName = "CommandEmpty"

interface CommandGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  heading?: string
}

const CommandGroup = React.forwardRef<HTMLDivElement, CommandGroupProps>(
  ({ className, heading, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("overflow-hidden text-foreground", className)}
      {...props}
    >
      {heading && (
        <div className="py-1.5 px-1.5 mx-1 text-xs font-medium text-muted-foreground">
          {heading}
        </div>
      )}
      {children}
    </div>
  ),
)
CommandGroup.displayName = "CommandGroup"

interface CommandItemProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string
  onSelect?: () => void
  disabled?: boolean
}

const CommandItem = React.forwardRef<HTMLDivElement, CommandItemProps>(
  ({ className, onSelect, value, onMouseEnter, disabled, ...props }, ref) => {
    const context = React.useContext(CommandContext)
    const itemRef = React.useRef<HTMLDivElement>(null)

    // Generate a stable value if not provided
    const itemValue = value || React.useId()

    // Register this item with the Command (skip if disabled)
    React.useEffect(() => {
      if (disabled) {
        context?.registerItem(itemValue, null)
        return
      }
      const element = itemRef.current
      context?.registerItem(itemValue, element)
      return () => {
        context?.registerItem(itemValue, null)
      }
    }, [context, itemValue, disabled])

    const isSelected = !disabled && context?.selectedValue === itemValue

    const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!disabled) {
        context?.setSelectedValue(itemValue)
      }
      onMouseEnter?.(e)
    }

    return (
      <div
        ref={itemRef}
        data-value={itemValue}
        data-selected={isSelected || undefined}
        data-disabled={disabled || undefined}
        className={cn(
          overlayItem,
          isSelected && "bg-accent dark:bg-neutral-800 text-accent-foreground",
          disabled && "opacity-40 pointer-events-none",
          className,
        )}
        onClick={disabled ? undefined : onSelect}
        onMouseEnter={handleMouseEnter}
        {...props}
      />
    )
  },
)
CommandItem.displayName = "CommandItem"

const CommandSeparator = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn(overlaySeparator, className)} {...props} />
))
CommandSeparator.displayName = "CommandSeparator"

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
}
