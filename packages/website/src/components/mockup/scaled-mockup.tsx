import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface ScaledMockupProps {
  width: number;
  height: number;
  children: ReactNode;
  label?: string;
  borderRadius?: number;
  className?: string;
}

export function ScaledMockup({
  width,
  height,
  children,
  label,
  borderRadius = 0,
  className = "",
}: ScaledMockupProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Measure layout width, not the transformed bounds of the tilted phones.
    setScale(container.clientWidth / width);
    const observer = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [width]);

  const frameStyle = useMemo(
    () => ({
      aspectRatio: `${width} / ${height}`,
      borderRadius: `${(borderRadius / width) * 100}% / ${(borderRadius / height) * 100}%`,
    }),
    [width, height, borderRadius],
  );
  const surfaceStyle = useMemo(
    () => ({ width, height, transform: `scale(${scale})` }),
    [width, height, scale],
  );

  return (
    <div
      ref={containerRef}
      role={label ? "img" : undefined}
      aria-label={label}
      className={`relative w-full overflow-hidden ${className}`}
      style={frameStyle}
    >
      <div className="absolute top-0 left-0 origin-top-left" style={surfaceStyle}>
        {children}
      </div>
    </div>
  );
}
