// RN's mobile base configs split accessibility props by OS. Desktop supports
// both sets, so do not silently drop Android-originated props on macOS.
// There is no public React Native export for BaseViewConfig.
// eslint-disable-next-line @react-native/no-deep-imports
import iosConfig from 'react-native/Libraries/NativeComponent/BaseViewConfig.ios';
// eslint-disable-next-line @react-native/no-deep-imports
import flattenStyle from 'react-native/Libraries/StyleSheet/flattenStyle';
// eslint-disable-next-line @react-native/no-deep-imports
import processBackgroundImage from 'react-native/Libraries/StyleSheet/processBackgroundImage';
// eslint-disable-next-line @react-native/no-deep-imports
import processBoxShadow from 'react-native/Libraries/StyleSheet/processBoxShadow';
// eslint-disable-next-line @react-native/no-deep-imports
import processColor from 'react-native/Libraries/StyleSheet/processColor';
// eslint-disable-next-line @react-native/no-deep-imports
import processTransform from 'react-native/Libraries/StyleSheet/processTransform';

// React Native parses only linear-gradient() and radial-gradient(). A repeating
// one is parsed as the plain gradient and marked with a first color stop at this
// position, which the renderer reads and removes.
const REPEATING_MARKER = -100000000;

function splitLayers(css: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
    } else if (character === ',' && depth === 0) {
      layers.push(css.slice(start, index));
      start = index + 1;
    }
  }
  layers.push(css.slice(start));
  return layers;
}

function processBackgroundImageWithRepeat(value: unknown) {
  if (typeof value !== 'string' || !/repeating-/i.test(value)) {
    return processBackgroundImage(value);
  }
  const images: unknown[] = [];
  for (const layer of splitLayers(value)) {
    const repeating = /^\s*repeating-/i.test(layer);
    const parsed = processBackgroundImage(
      layer.replace(/^(\s*)repeating-/i, '$1'),
    );
    for (const image of parsed) {
      if (repeating && image.colorStops != null) {
        image.colorStops = [
          { color: 0, position: REPEATING_MARKER },
          ...image.colorStops,
        ];
      }
      images.push(image);
    }
  }
  return images;
}

const BORDER_SIDES = ['Left', 'Top', 'Right', 'Bottom'] as const;
const STATE_STYLE_PROPS = new Set([
  'backgroundColor',
  'opacity',
  'boxShadow',
  'color',
  'borderColor',
  'transform',
  'outlineColor',
  'outlineWidth',
  'outlineOffset',
  ...BORDER_SIDES.map(side => `border${side}Color`),
]);

// x' = a x + c y + tx, y' = b x + d y + ty
type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function angle(value: unknown): number {
  const text = String(value);
  const amount = parseFloat(text);
  return text.endsWith('deg') ? (amount * Math.PI) / 180 : amount;
}

// The 2D part of a transform, as the column-major 4x4 Fabric uses. The depth
// and perspective rows are not part of a state style.
function transformMatrix(value: unknown): number[] | null {
  const steps = processTransform(value as never) as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(steps)) {
    return null;
  }
  let result = IDENTITY;
  for (const step of steps) {
    const [name] = Object.keys(step);
    const amount = step[name];
    let next: Affine = IDENTITY;
    switch (name) {
      case 'translateX':
        next = [1, 0, 0, 1, Number(amount), 0];
        break;
      case 'translateY':
        next = [1, 0, 0, 1, 0, Number(amount)];
        break;
      case 'translate':
        next = [
          1,
          0,
          0,
          1,
          Number((amount as number[])[0]),
          Number((amount as number[])[1]),
        ];
        break;
      case 'scale':
        next = [Number(amount), 0, 0, Number(amount), 0, 0];
        break;
      case 'scaleX':
        next = [Number(amount), 0, 0, 1, 0, 0];
        break;
      case 'scaleY':
        next = [1, 0, 0, Number(amount), 0, 0];
        break;
      case 'rotate':
      case 'rotateZ': {
        const radians = angle(amount);
        next = [
          Math.cos(radians),
          Math.sin(radians),
          -Math.sin(radians),
          Math.cos(radians),
          0,
          0,
        ];
        break;
      }
      case 'skewX':
        next = [1, 0, Math.tan(angle(amount)), 1, 0, 0];
        break;
      case 'skewY':
        next = [1, Math.tan(angle(amount)), 0, 1, 0, 0];
        break;
      case 'matrix': {
        const m = amount as number[];
        next = [m[0], m[1], m[4], m[5], m[12], m[13]];
        break;
      }
      default:
        warnOnce(`State styles do not support the transform "${name}".`);
    }
    result = multiply(result, next);
  }
  const matrix = new Array<number>(16).fill(0);
  matrix[0] = result[0];
  matrix[1] = result[1];
  matrix[4] = result[2];
  matrix[5] = result[3];
  matrix[10] = 1;
  matrix[12] = result[4];
  matrix[13] = result[5];
  matrix[15] = 1;
  return matrix;
}
const warned = new Set<string>();

function warnOnce(message: string) {
  if (__DEV__ && !warned.has(message)) {
    warned.add(message);
    console.warn(message);
  }
}

// A state style crosses to native as JSON text with colors already resolved, so
// Fabric only diffs and forwards a string.
function stateStyleObject(prop: string, style: unknown) {
  const flat = flattenStyle(style);
  const out: Record<string, unknown> = {};
  if (!flat) {
    return out;
  }
  for (const key of Object.keys(flat)) {
    const value = flat[key];
    if (value == null) {
      continue;
    }
    if (!STATE_STYLE_PROPS.has(key)) {
      warnOnce(`${prop} does not support the style property "${key}".`);
    } else if (key === 'transform') {
      const matrix = transformMatrix(value);
      if (matrix) {
        out.transform = matrix;
      }
    } else if (
      key === 'backgroundColor' ||
      key === 'color' ||
      key === 'outlineColor' ||
      /^border(Left|Top|Right|Bottom)?Color$/.test(key)
    ) {
      const color = processColor(value);
      if (typeof color === 'number') {
        out[key] = color;
      } else {
        warnOnce(`${prop} supports plain colors in ${key} only.`);
      }
    } else if (
      key === 'opacity' ||
      key === 'outlineWidth' ||
      key === 'outlineOffset'
    ) {
      out[key] = value;
    } else {
      out.boxShadow = processBoxShadow(value).map(shadow => ({
        ...shadow,
        color: shadow.color == null ? undefined : processColor(shadow.color),
      }));
    }
  }
  return out;
}

function processStateStyle(prop: string) {
  return (style: unknown) => JSON.stringify(stateStyleObject(prop, style));
}

function processGroupStateStyle(prop: string) {
  return (value: { group?: unknown; style?: unknown } | null) => {
    if (value == null) {
      return '';
    }
    if (typeof value.group !== 'string' || value.group === '') {
      warnOnce(`${prop} needs a group name: { group: 'name', style: {...} }.`);
      return '';
    }
    return JSON.stringify({
      group: value.group,
      style: stateStyleObject(prop, value.style),
    });
  };
}

export default {
  ...iosConfig,
  // A native `topContextMenu` event reaches the view's `onContextMenu` handler
  //. It is registered the same way RN registers `onPointerEnter`
  // (a bubbling event plus a `validAttributes` marker), because Fabric converts
  // the JS handler function into the boolean marker that creates the listener.
  directEventTypes: {
    ...iosConfig.directEventTypes,
    topWheelEnd: { registrationName: 'onWheelEnd' },
  },
  bubblingEventTypes: {
    ...iosConfig.bubblingEventTypes,
    topContextMenu: {
      phasedRegistrationNames: {
        bubbled: 'onContextMenu',
        captured: 'onContextMenuCapture',
      },
    },
    topWheel: {
      phasedRegistrationNames: {
        bubbled: 'onWheel',
        captured: 'onWheelCapture',
      },
    },
    topDragEnter: {
      phasedRegistrationNames: {
        bubbled: 'onDragEnter',
        captured: 'onDragEnterCapture',
      },
    },
    topDragOver: {
      phasedRegistrationNames: {
        bubbled: 'onDragOver',
        captured: 'onDragOverCapture',
      },
    },
    topDragLeave: {
      phasedRegistrationNames: {
        bubbled: 'onDragLeave',
        captured: 'onDragLeaveCapture',
      },
    },
    topDragStart: {
      phasedRegistrationNames: {
        bubbled: 'onDragStart',
        captured: 'onDragStartCapture',
      },
    },
    topDrag: {
      phasedRegistrationNames: {
        bubbled: 'onDrag',
        captured: 'onDragCapture',
      },
    },
    topDragEnd: {
      phasedRegistrationNames: {
        bubbled: 'onDragEnd',
        captured: 'onDragEndCapture',
      },
    },
    topDrop: {
      phasedRegistrationNames: {
        bubbled: 'onDrop',
        captured: 'onDropCapture',
      },
    },
  },
  validAttributes: {
    ...iosConfig.validAttributes,
    accessibilityLabelledBy: true,
    accessibilityLiveRegion: true,
    importantForAccessibility: true,
    focusable: true,
    desktopDragRegion: true,
    group: true,
    style: {
      ...(iosConfig.validAttributes.style as object),
      backgroundImage: { process: processBackgroundImageWithRepeat },
      experimental_backgroundImage: {
        process: processBackgroundImageWithRepeat,
      },
    },
    hoverStyle: { process: processStateStyle('hoverStyle') },
    activeStyle: { process: processStateStyle('activeStyle') },
    focusStyle: { process: processStateStyle('focusStyle') },
    focusVisibleStyle: { process: processStateStyle('focusVisibleStyle') },
    groupHoverStyle: { process: processGroupStateStyle('groupHoverStyle') },
    groupActiveStyle: { process: processGroupStateStyle('groupActiveStyle') },
    onContextMenu: true,
    onContextMenuCapture: true,
    onWheel: true,
    onWheelCapture: true,
    acceptsFiles: true,
    tooltip: true,
    draggable: true,
    droppable: true,
    onDragStart: true,
    onDragStartCapture: true,
    onDrag: true,
    onDragCapture: true,
    onDragEnd: true,
    onDragEndCapture: true,
    onDragEnter: true,
    onDragEnterCapture: true,
    onDragOver: true,
    onDragOverCapture: true,
    onDragLeave: true,
    onDragLeaveCapture: true,
    onDrop: true,
    onDropCapture: true,
    dragOverStyle: { process: processStateStyle('dragOverStyle') },
    // RN omits iOS listener flags when Platform.OS is an out-of-tree platform.
    // Fabric's AccessibilityProps needs these flags for native action routing.
    onAccessibilityAction: true,
    onAccessibilityEscape: true,
    onAccessibilityTap: true,
  },
};
