import { useAtom, type WritableAtom } from "jotai"
import { AnimatePresence, motion } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal, flushSync } from "react-dom"
import { Kbd } from "./kbd"

interface ResizableSidebarProps {
  isOpen: boolean
  onClose: () => void
  widthAtom: WritableAtom<number, [number], void>
  minWidth?: number
  maxWidth?: number
  side: "left" | "right"
  closeHotkey?: string
  animationDuration?: number
  children: React.ReactNode
  className?: string
  initialWidth?: number | string
  exitWidth?: number | string
  disableClickToClose?: boolean
  showResizeTooltip?: boolean
  style?: React.CSSProperties
}

const DEFAULT_MIN_WIDTH = 200
const DEFAULT_MAX_WIDTH = 9999
const DEFAULT_ANIMATION_DURATION = 0
const EXTENDED_HOVER_AREA_WIDTH = 8

export function ResizableSidebar({
  isOpen,
  onClose,
  widthAtom,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  side,
  closeHotkey,
  animationDuration = DEFAULT_ANIMATION_DURATION,
  children,
  className = "",
  initialWidth = 0,
  exitWidth = 0,
  disableClickToClose = false,
  showResizeTooltip = false,
  style,
}: ResizableSidebarProps) {
  const [sidebarWidth, setSidebarWidth] = useAtom(widthAtom)

  const hasOpenedOnce = useRef(false)
  const wasOpenRef = useRef(false)
  const [shouldAnimate, setShouldAnimate] = useState(!isOpen)

  const [isResizing, setIsResizing] = useState(false)
  const [isHoveringResizeHandle, setIsHoveringResizeHandle] = useState(false)
  const [tooltipY, setTooltipY] = useState<number | null>(null)
  const [isTooltipDismissed, setIsTooltipDismissed] = useState(false)
  const resizeHandleRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [localWidth, setLocalWidth] = useState<number | null>(null)

  const currentWidth = localWidth ?? sidebarWidth

  const tooltipPosition = useMemo(() => {
    if (!tooltipY || !sidebarRef.current) return null
    const rect = sidebarRef.current.getBoundingClientRect()
    const x = side === "left" ? rect.right + 8 : rect.left - 8
    return { x, y: tooltipY }
  }, [tooltipY, currentWidth, side])

  useEffect(() => {
    if (!isOpen && wasOpenRef.current) {
      hasOpenedOnce.current = false
      setShouldAnimate(true)
      setLocalWidth(null)
    }
    if (isOpen) {
      setIsTooltipDismissed(false)
    }
    wasOpenRef.current = isOpen

    if (isOpen && !hasOpenedOnce.current) {
      const timer = setTimeout(
        () => {
          hasOpenedOnce.current = true
          setShouldAnimate(false)
        },
        animationDuration * 1000 + 50,
      )
      return () => clearTimeout(timer)
    } else if (isOpen && hasOpenedOnce.current) {
      setShouldAnimate(false)
    }
  }, [isOpen, animationDuration])

  const handleClose = useCallback(() => {
    if (isHoveringResizeHandle && !isTooltipDismissed) {
      flushSync(() => {
        setIsTooltipDismissed(true)
      })
    }
    flushSync(() => {
      if (isResizing) setIsResizing(false)
      if (localWidth !== null) setLocalWidth(null)
    })
    setShouldAnimate(true)
    onClose()
    setIsHoveringResizeHandle(false)
    setTooltipY(null)
  }, [
    onClose,
    isOpen,
    shouldAnimate,
    isResizing,
    localWidth,
    isHoveringResizeHandle,
    isTooltipDismissed,
  ])

  useEffect(() => {
    if (!isOpen) {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current)
        tooltipTimeoutRef.current = null
      }
      setIsHoveringResizeHandle(false)
      setTooltipY(null)
    }
    return () => {
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current)
        tooltipTimeoutRef.current = null
      }
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !isHoveringResizeHandle || isTooltipDismissed) return

    const handleDocumentClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const tooltipElement = target.closest('[data-tooltip="true"]')
      const isClickOnTooltip =
        tooltipElement ||
        (tooltipRef.current && tooltipRef.current.contains(target))

      if (isClickOnTooltip) {
        e.preventDefault()
        e.stopPropagation()
        flushSync(() => {
          setIsTooltipDismissed(true)
        })
        handleClose()
      }
    }

    document.addEventListener("click", handleDocumentClick, true)
    document.addEventListener("pointerdown", handleDocumentClick, true)

    return () => {
      document.removeEventListener("click", handleDocumentClick, true)
      document.removeEventListener("pointerdown", handleDocumentClick, true)
    }
  }, [isOpen, isHoveringResizeHandle, isTooltipDismissed, handleClose])

  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return

      event.preventDefault()
      event.stopPropagation()

      const startX = event.clientX
      const startWidth = sidebarWidth
      const pointerId = event.pointerId
      let hasMoved = false
      let currentLocalWidth: number | null = null

      const handleElement =
        resizeHandleRef.current ?? (event.currentTarget as HTMLElement)

      const clampWidth = (width: number) =>
        Math.max(minWidth, Math.min(maxWidth, width))

      handleElement.setPointerCapture?.(pointerId)
      if (tooltipTimeoutRef.current) {
        clearTimeout(tooltipTimeoutRef.current)
        tooltipTimeoutRef.current = null
      }
      setIsResizing(true)
      setIsHoveringResizeHandle(false)

      const updateWidth = (clientX: number) => {
        const delta = side === "left" ? clientX - startX : startX - clientX
        const newWidth = clampWidth(startWidth + delta)
        currentLocalWidth = newWidth
        setLocalWidth(newWidth)
      }

      const handlePointerMove = (pointerEvent: PointerEvent) => {
        const delta = Math.abs(
          side === "left"
            ? pointerEvent.clientX - startX
            : startX - pointerEvent.clientX,
        )
        if (!hasMoved && delta >= 3) hasMoved = true
        if (hasMoved) updateWidth(pointerEvent.clientX)
      }

      const finishResize = (pointerEvent?: PointerEvent) => {
        if (handleElement.hasPointerCapture?.(pointerId)) {
          handleElement.releasePointerCapture(pointerId)
        }

        document.removeEventListener("pointermove", handlePointerMove)
        document.removeEventListener("pointerup", handlePointerUp)
        document.removeEventListener("pointercancel", handlePointerCancel)
        setIsResizing(false)

        if (!hasMoved && pointerEvent && !disableClickToClose) {
          handleClose()
        } else if (hasMoved && pointerEvent) {
          const delta =
            side === "left"
              ? pointerEvent.clientX - startX
              : startX - pointerEvent.clientX
          const finalWidth = clampWidth(startWidth + delta)
          setSidebarWidth(finalWidth)
          setLocalWidth(null)
        } else {
          if (currentLocalWidth !== null) {
            setSidebarWidth(currentLocalWidth)
            setLocalWidth(null)
          }
        }
      }

      const handlePointerUp = (pointerEvent: PointerEvent) => {
        finishResize(pointerEvent)
      }

      const handlePointerCancel = () => {
        finishResize()
      }

      document.addEventListener("pointermove", handlePointerMove)
      document.addEventListener("pointerup", handlePointerUp, { once: true })
      document.addEventListener("pointercancel", handlePointerCancel, {
        once: true,
      })
    },
    [
      sidebarWidth,
      setSidebarWidth,
      handleClose,
      minWidth,
      maxWidth,
      side,
      disableClickToClose,
    ],
  )

  const resizeHandleStyle = useMemo(() => {
    if (side === "left") {
      return {
        right: "0px",
        width: "4px",
        marginRight: "-2px",
        paddingLeft: "2px",
        paddingRight: "2px",
      }
    } else {
      return {
        left: "0px",
        width: "4px",
        marginLeft: "-2px",
        paddingLeft: "2px",
        paddingRight: "2px",
      }
    }
  }, [side])

  const extendedHoverAreaStyle = useMemo(() => {
    if (side === "left") {
      return { width: `${EXTENDED_HOVER_AREA_WIDTH}px`, right: "0px" }
    } else {
      return { width: `${EXTENDED_HOVER_AREA_WIDTH}px`, left: "0px" }
    }
  }, [side])

  return (
    <>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            ref={sidebarRef}
            initial={
              !shouldAnimate
                ? { width: currentWidth, opacity: 1 }
                : { width: initialWidth, opacity: 0 }
            }
            animate={{ width: currentWidth, opacity: 1 }}
            exit={{ width: exitWidth, opacity: 0 }}
            transition={{
              duration: isResizing ? 0 : animationDuration,
              ease: [0.4, 0, 0.2, 1],
            }}
            className={`bg-transparent flex flex-col text-xs h-full relative ${className}`}
            style={{ minWidth: minWidth, overflow: "hidden", ...style }}
          >
            {/* Extended hover area */}
            <div
              data-extended-hover-area
              className="absolute top-0 bottom-0 cursor-col-resize"
              style={{
                ...extendedHoverAreaStyle,
                pointerEvents: isResizing ? "none" : "auto",
                zIndex: isResizing ? 5 : 10,
              }}
              onPointerDown={handleResizePointerDown}
              onMouseEnter={(e) => {
                if (isResizing) return
                if (tooltipTimeoutRef.current) {
                  clearTimeout(tooltipTimeoutRef.current)
                }
                if (!tooltipY) setTooltipY(e.clientY)
                tooltipTimeoutRef.current = setTimeout(() => {
                  setIsHoveringResizeHandle(true)
                }, 300)
              }}
              onMouseLeave={(e) => {
                if (isResizing) return
                if (tooltipTimeoutRef.current) {
                  clearTimeout(tooltipTimeoutRef.current)
                  tooltipTimeoutRef.current = null
                }
                const relatedTarget = e.relatedTarget
                if (
                  relatedTarget instanceof Node &&
                  (resizeHandleRef.current?.contains(relatedTarget) ||
                    resizeHandleRef.current === relatedTarget)
                ) {
                  return
                }
                setIsHoveringResizeHandle(false)
                setTooltipY(null)
                setIsTooltipDismissed(false)
              }}
            />

            {/* Resize Handle */}
            <div
              ref={resizeHandleRef}
              onPointerDown={handleResizePointerDown}
              onMouseEnter={(e) => {
                if (tooltipTimeoutRef.current) {
                  clearTimeout(tooltipTimeoutRef.current)
                }
                if (!tooltipY) setTooltipY(e.clientY)
                tooltipTimeoutRef.current = setTimeout(() => {
                  setIsHoveringResizeHandle(true)
                }, 300)
              }}
              onMouseLeave={(e) => {
                if (tooltipTimeoutRef.current) {
                  clearTimeout(tooltipTimeoutRef.current)
                  tooltipTimeoutRef.current = null
                }
                const relatedTarget = e.relatedTarget
                if (
                  relatedTarget instanceof Element &&
                  relatedTarget.closest("[data-extended-hover-area]")
                ) {
                  return
                }
                setIsHoveringResizeHandle(false)
                setTooltipY(null)
                setIsTooltipDismissed(false)
              }}
              className="absolute top-0 bottom-0 cursor-col-resize z-10"
              style={resizeHandleStyle}
            />

            {/* Hover Tooltip */}
            {showResizeTooltip &&
              isHoveringResizeHandle &&
              !isResizing &&
              !isTooltipDismissed &&
              tooltipPosition &&
              createPortal(
                <AnimatePresence>
                  {tooltipPosition && (
                    <motion.div
                      key="tooltip"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.05, ease: "easeOut" }}
                      className="fixed z-10"
                      style={{
                        left: `${tooltipPosition.x}px`,
                        top: `${tooltipPosition.y}px`,
                        transform:
                          side === "left"
                            ? "translateY(-50%)"
                            : "translateX(-100%) translateY(-50%)",
                        transformOrigin:
                          side === "left" ? "left center" : "right center",
                        pointerEvents: "none",
                      }}
                    >
                      <div
                        ref={tooltipRef}
                        role="dialog"
                        data-tooltip="true"
                        className="relative rounded-md border border-border bg-popover px-2 py-1 flex flex-col items-start gap-0.5 text-xs text-popover-foreground shadow-lg pointer-events-auto"
                        onPointerDown={(e) => {
                          e.stopPropagation()
                          if (e.button === 0) {
                            flushSync(() => {
                              setIsTooltipDismissed(true)
                            })
                            handleClose()
                          }
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          flushSync(() => {
                            setIsTooltipDismissed(true)
                          })
                          handleClose()
                        }}
                      >
                        {!disableClickToClose && (
                          <div className="flex items-center gap-1 text-xs">
                            <span>Close</span>
                            <span className="text-muted-foreground inline-flex items-center gap-1">
                              <span>Click</span>
                              {closeHotkey && (
                                <>
                                  <span>or</span>
                                  <Kbd>{closeHotkey}</Kbd>
                                </>
                              )}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center gap-1 text-xs">
                          <span>Resize</span>
                          <span className="text-muted-foreground">Drag</span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>,
                document.body,
              )}

            {/* Children content */}
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
