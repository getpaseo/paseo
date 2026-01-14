import { createContext, useContext, useEffect, useRef, useState } from 'react'

// --- Vector math utilities ---

interface Vec2 {
  x: number
  y: number
}

function vec2(x: number, y: number): Vec2 {
  return { x, y }
}

function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s }
}

function length(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y)
}

function normalize(v: Vec2): Vec2 {
  const len = length(v)
  if (len === 0) return { x: 0, y: 0 }
  return { x: v.x / len, y: v.y / len }
}

function lerpAngle(a: number, b: number, t: number): number {
  // Handle angle wrapping for smooth interpolation
  let diff = b - a
  while (diff > 180) diff -= 360
  while (diff < -180) diff += 360
  return a + diff * t
}

// --- Cursor context ---

const CursorContext = createContext<Vec2 | null>(null)

export function CursorFieldProvider({ children }: { children: React.ReactNode }) {
  const [cursor, setCursor] = useState<Vec2 | null>(null)

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      setCursor({ x: e.clientX, y: e.clientY })
    }

    function handleMouseLeave() {
      setCursor(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseleave', handleMouseLeave)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [])

  return <CursorContext.Provider value={cursor}>{children}</CursorContext.Provider>
}

// --- Physics simulation state ---

interface ButterflyState {
  position: Vec2 // Current offset from origin
  velocity: Vec2 // Current velocity
  heading: number // Current facing angle in degrees (0 = down, positive = clockwise)
  targetHeading: number // Target heading to smoothly rotate towards
}

// Physics constants
const WANDER_STRENGTH = 0.15 // How strongly butterflies wander
const WANDER_RADIUS = 40 // Max wander distance from origin
const RETURN_STRENGTH = 0.02 // How strongly butterflies return to origin
const REPULSION_RADIUS = 150 // Cursor repulsion detection radius
const REPULSION_STRENGTH = 2.5 // How strongly cursor repels
const MAX_SPEED = 1.5 // Maximum velocity
const FRICTION = 0.98 // Velocity damping per frame
const HEADING_SMOOTHING = 0.08 // How quickly heading catches up to velocity direction

// --- Butterfly visual component ---

interface ButterflyVisualProps {
  size?: number
  color?: string
  delay?: number
  duration?: number
  direction?: 'left' | 'right'
  heading?: number
}

function ButterflyVisual({
  size = 40,
  color = '#e8a87c',
  delay = 0,
  duration = 0.5,
  direction = 'right',
  heading = 0,
}: ButterflyVisualProps) {
  const wingStyle = {
    animationDelay: `${delay}s`,
    animationDuration: `${duration}s`,
  }

  const scaleX = direction === 'left' ? -1 : 1

  // Base butterfly has rotate(30deg), so it's already looking 30° down from horizontal.
  // To keep it in the bottom half (never looking up), rotateZ range is -30° to +90°
  // -30° = horizontal, 0° = 30° down (base), +90° = 120° down (nearly straight down)
  const clampedHeading = Math.max(-30, Math.min(90, heading))

  return (
    <div
      className="animate-flutter-body"
      style={{
        animationDelay: `${delay}s`,
        animationDuration: `${duration}s`,
      }}
    >
      <svg
        viewBox="0 0 50 40"
        width={size}
        height={size * 0.8}
        style={{
          filter: 'url(#painterly)',
          transform: `scaleX(${scaleX}) rotateY(25deg) rotate(30deg) rotateZ(${clampedHeading}deg)`,
          transition: 'transform 0.3s ease-out',
        }}
      >
        <defs>
          <filter id="painterly" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="2" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>

        {/* Far side wings (darker, behind, slightly rotated) */}
        <g
          className="animate-flutter-left origin-[38px_20px]"
          style={{ ...wingStyle, animationDelay: `${delay + 0.08}s` }}
          transform="translate(6, 0) rotate(8, 38, 20)"
        >
          <path d="M38 20 Q20 2 8 10 Q0 18 10 28 Q25 32 38 22" fill={darken(color, 50)} />
          <path d="M38 22 Q25 30 18 38 Q28 42 36 34 Q40 28 38 24" fill={darken(color, 50)} />
        </g>

        {/* Near side wings (main color, front) */}
        <g className="animate-flutter-left origin-[38px_20px]" style={wingStyle}>
          <path d="M38 20 Q20 2 8 10 Q0 18 10 28 Q25 32 38 22" fill={color} />
        </g>

        <g className="animate-flutter-left origin-[38px_20px]" style={{ ...wingStyle, animationDelay: `${delay + 0.05}s` }}>
          <path d="M38 22 Q25 30 18 38 Q28 42 36 34 Q40 28 38 24" fill={color} />
        </g>
      </svg>
    </div>
  )
}

function darken(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16)
  const r = Math.max(0, (num >> 16) - amount)
  const g = Math.max(0, ((num >> 8) & 0x00ff) - amount)
  const b = Math.max(0, (num & 0x0000ff) - amount)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

// --- Main FloatingButterfly component with physics ---

interface FloatingButterflyProps {
  style?: React.CSSProperties
  size?: number
  color?: string
  delay?: number
  duration?: number
  direction?: 'left' | 'right'
}

export function FloatingButterfly({ style, size, color, delay, duration, direction }: FloatingButterflyProps) {
  // Initialize state lazily to avoid hydration mismatch
  const initialStateRef = useRef<{ x: number; y: number; heading: number } | null>(null)
  if (initialStateRef.current === null && typeof window !== 'undefined') {
    // Random starting position within wander radius
    const angle = Math.random() * Math.PI * 2
    const dist = Math.random() * WANDER_RADIUS * 0.5
    initialStateRef.current = {
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      heading: Math.random() * 40 - 10,
    }
  }

  const [mounted, setMounted] = useState(false)
  const [renderState, setRenderState] = useState({ x: 0, y: 0, heading: 0 })

  const stateRef = useRef<ButterflyState | null>(null)
  const elementRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const wanderAngleRef = useRef(Math.random() * Math.PI * 2)
  const lastTimeRef = useRef<number | null>(null)

  const cursor = useContext(CursorContext)
  const cursorRef = useRef<Vec2 | null>(null)

  useEffect(() => {
    // Initialize physics state on mount with pre-computed random values
    const init = initialStateRef.current || { x: 0, y: 0, heading: 0 }
    stateRef.current = {
      position: vec2(init.x, init.y),
      velocity: vec2(0, 0),
      heading: init.heading,
      targetHeading: init.heading,
    }
    // Set initial render state to match physics state
    setRenderState({ x: init.x, y: init.y, heading: init.heading })
    setMounted(true)
  }, [])

  // Keep cursor ref in sync
  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    if (!mounted) return

    function simulate(timestamp: number) {
      const state = stateRef.current
      if (!state) return

      // Skip first frame to let things settle, then start tracking time
      if (lastTimeRef.current === null) {
        lastTimeRef.current = timestamp
        rafRef.current = requestAnimationFrame(simulate)
        return
      }

      // Calculate delta time (cap at 50ms to avoid huge jumps)
      const dt = Math.min((timestamp - lastTimeRef.current) / 16.67, 3)
      lastTimeRef.current = timestamp

      let acceleration = vec2(0, 0)

      // 1. Wander behavior - gentle random movement
      wanderAngleRef.current += (Math.random() - 0.5) * 0.3 * dt
      const wanderForce = vec2(
        Math.cos(wanderAngleRef.current) * WANDER_STRENGTH,
        Math.sin(wanderAngleRef.current) * WANDER_STRENGTH
      )
      acceleration = add(acceleration, wanderForce)

      // 2. Return to origin - soft spring force
      const distFromOrigin = length(state.position)
      if (distFromOrigin > WANDER_RADIUS * 0.5) {
        const returnForce = scale(normalize(scale(state.position, -1)), RETURN_STRENGTH * (distFromOrigin / WANDER_RADIUS))
        acceleration = add(acceleration, returnForce)
      }

      // 3. Cursor repulsion
      const currentCursor = cursorRef.current
      if (currentCursor && elementRef.current) {
        const rect = elementRef.current.getBoundingClientRect()
        const worldPos = vec2(rect.left + rect.width / 2 + state.position.x, rect.top + rect.height / 2 + state.position.y)

        const toCursor = sub(worldPos, currentCursor)
        const distToCursor = length(toCursor)

        if (distToCursor < REPULSION_RADIUS && distToCursor > 0) {
          // Inverse square falloff for more natural feel
          const strength = REPULSION_STRENGTH * Math.pow(1 - distToCursor / REPULSION_RADIUS, 2)
          const repulsionForce = scale(normalize(toCursor), strength)
          acceleration = add(acceleration, repulsionForce)
        }
      }

      // 4. Update velocity with acceleration
      state.velocity = add(state.velocity, scale(acceleration, dt))

      // 5. Apply friction
      state.velocity = scale(state.velocity, Math.pow(FRICTION, dt))

      // 6. Clamp velocity to max speed
      const speed = length(state.velocity)
      if (speed > MAX_SPEED) {
        state.velocity = scale(normalize(state.velocity), MAX_SPEED)
      }

      // 7. Update position
      state.position = add(state.position, scale(state.velocity, dt))

      // 8. Soft clamp position to wander radius
      const posLen = length(state.position)
      if (posLen > WANDER_RADIUS) {
        state.position = scale(normalize(state.position), WANDER_RADIUS)
        // Dampen velocity when hitting boundary
        state.velocity = scale(state.velocity, 0.8)
      }

      // 9. Calculate target heading from velocity direction
      if (speed > 0.1) {
        // Convert velocity to angle: 0 = moving down screen (+Y), positive = clockwise
        const rawHeading = Math.atan2(state.velocity.x, state.velocity.y) * (180 / Math.PI)
        // Clamp to valid range: -30° to +90° (relative to base 30° rotation)
        state.targetHeading = Math.max(-30, Math.min(90, rawHeading))
      }

      // 10. Smoothly interpolate heading towards target (already clamped)
      state.heading = lerpAngle(state.heading, state.targetHeading, HEADING_SMOOTHING * dt)

      // Update render state
      setRenderState({
        x: state.position.x,
        y: state.position.y,
        heading: state.heading,
      })

      rafRef.current = requestAnimationFrame(simulate)
    }

    rafRef.current = requestAnimationFrame(simulate)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [mounted])

  if (!mounted) return null

  return (
    <div
      ref={elementRef}
      className="absolute pointer-events-none"
      style={{
        ...style,
        transform: `translate(${renderState.x}px, ${renderState.y}px)`,
      }}
    >
      <ButterflyVisual size={size} color={color} delay={delay} duration={duration} direction={direction} heading={renderState.heading} />
    </div>
  )
}
