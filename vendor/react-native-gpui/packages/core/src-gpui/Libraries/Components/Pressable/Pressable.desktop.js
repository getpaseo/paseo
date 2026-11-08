import React, { forwardRef, memo, useCallback, useState } from 'react';
import NativePressable from './Pressable';

// Keep RN's press, focus, accessibility and delayed-hover handling. Desktop
// also exposes hover state to style/children render props, as RN Web does.
const Pressable = forwardRef(function DesktopPressable(
  { style, children, onHoverIn, onHoverOut, disabled, ...props },
  ref,
) {
  const [pointerInside, setPointerInside] = useState(false);
  const hovered = pointerInside && !disabled;
  const handleHoverIn = useCallback(event => {
    setPointerInside(true);
    onHoverIn?.(event);
  }, [onHoverIn]);
  const handleHoverOut = useCallback(event => {
    setPointerInside(false);
    onHoverOut?.(event);
  }, [onHoverOut]);
  const renderStyle = useCallback(state => style({ ...state, hovered }), [style, hovered]);
  const renderChildren = useCallback(state => children({ ...state, hovered }), [children, hovered]);
  return (
    <NativePressable
      {...props}
      ref={ref}
      disabled={disabled}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={typeof style === 'function' ? renderStyle : style}
    >
      {typeof children === 'function' ? renderChildren : children}
    </NativePressable>
  );
});

export default memo(Pressable);
