import { Dimensions } from 'react-native';
import { useEffect, useState } from 'react';
import {
  MAIN_WINDOW_ID,
  useDesktopWindowId,
} from '@react-native-gpui/core/desktop';
import { useWindowStateSelector } from '@react-native-gpui/core/src-gpui/src/private/desktop/windows';

// The main window is what `Dimensions` describes. Any other window reports its
// own size and scale from its window state, with the system font scale.
function useMainWindowDimensions() {
  const [dimensions, setDimensions] = useState(() => Dimensions.get('window'));
  useEffect(() => {
    function handleChange({ window }) {
      if (
        dimensions.width !== window.width ||
        dimensions.height !== window.height ||
        dimensions.scale !== window.scale ||
        dimensions.fontScale !== window.fontScale
      ) {
        setDimensions(window);
      }
    }
    const subscription = Dimensions.addEventListener('change', handleChange);
    handleChange({ window: Dimensions.get('window') });
    return () => {
      subscription.remove();
    };
  }, [dimensions]);
  return dimensions;
}

function selectSize(state) {
  return state == null
    ? null
    : {
        width: state.bounds.width,
        height: state.bounds.height,
        scale: state.scaleFactor,
      };
}

function sameSize(a, b) {
  return a === null || b === null
    ? a === b
    : a.width === b.width && a.height === b.height && a.scale === b.scale;
}

export default function useWindowDimensions() {
  const windowId = useDesktopWindowId();
  const main = useMainWindowDimensions();
  // The main window's size comes from `Dimensions`; following its window
  // state too would re-render every caller on each frame of a move.
  const size = useWindowStateSelector(
    windowId === MAIN_WINDOW_ID ? null : windowId,
    selectSize,
    sameSize,
  );
  if (size == null) {
    return main;
  }
  return { ...size, fontScale: main.fontScale };
}
