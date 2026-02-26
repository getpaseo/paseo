import * as React from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "@/lib/cn"
import {
  overlayContentBase,
  overlayMaxHeight,
  overlayAnimation,
  overlaySlideIn,
} from "@/lib/overlay-styles"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
    forceDark?: boolean
  }
>(
  (
    { className, align = "center", sideOffset = 4, forceDark = true, ...props },
    ref,
  ) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          overlayContentBase,
          overlayMaxHeight,
          overlayAnimation,
          overlaySlideIn,
          "min-w-[200px] py-1",
          forceDark && "dark",
          className,
        )}
        data-popover="true"
        {...props}
      />
    </PopoverPrimitive.Portal>
  ),
)
PopoverContent.displayName = PopoverPrimitive.Content.displayName

const PopoverClose = PopoverPrimitive.Close

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose }
