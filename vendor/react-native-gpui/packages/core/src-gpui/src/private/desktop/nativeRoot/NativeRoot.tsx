/**
 * Renders React elements whose types name native components into one native
 * tree, instead of one Fabric node each.
 *
 * ```tsx
 * <NativeRoot style={{ width: 240, height: 120 }}>
 *   <Dialog title="Delete">
 *     <Button label="Cancel" onPress={close} />
 *   </Dialog>
 * </NativeRoot>
 * ```
 *
 * The children are described to a second reconciler: hooks, state and effects
 * work as everywhere, and the contexts the NativeRoot is rendered under are
 * visible inside it. A component that needs a React Native view inside the tree
 * puts it in a slot; everything else becomes an instance in the runtime and
 * costs no layout pass of its own.
 *
 * @format
 */

import * as React from 'react';
import { FiberProvider, useContextBridge } from 'its-fine';
import { StyleSheet, type ViewProps } from 'react-native';
import DesktopNativeRootNativeComponent from '../../specs/DesktopNativeRootNativeComponent';
import DesktopNativeSlotNativeComponent from '../../specs/DesktopNativeSlotNativeComponent';
import { createNativeRoot, type NativeRootHandle } from './reconciler';
import { SlotContext, type SlotApi, type SlotContent } from './slots';

export type NativeRootProps = ViewProps & {
  children?: React.ReactNode;
  /**
   * Without a width in its style, the box is as wide as its content: its
   * max-content width, shrinking to no less than its min-content width when
   * its parent has less room, as a flex item in GPUI would.
   */
  fitWidth?: boolean;
};

type RememberedSize = { height: number; width?: number; minWidth?: number };

const MAX_REMEMBERED = 512;
const MAX_SIGNATURE_NODES = 256;
const rememberedSizes = new Map<string, RememberedSize>();

function remember(key: string, size: RememberedSize) {
  rememberedSizes.delete(key);
  rememberedSizes.set(key, size);
  if (rememberedSizes.size > MAX_REMEMBERED) {
    rememberedSizes.delete(rememberedSizes.keys().next().value as string);
  }
}

const typeIds = new WeakMap<object, number>();
let nextTypeId = 1;

/**
 * A hash of the elements and their primitive props, which is what decides the
 * size of a tree that renders the same each time. Null for a tree too large to
 * be worth remembering.
 */
function childrenSignature(
  children: React.ReactNode,
  fitWidth: boolean,
  width: unknown,
): string | null {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  let nodes = 0;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b + code, 0x85ebca6b) ^ (b >>> 13);
    }
    a = Math.imul(a ^ 0xff, 0x01000193);
  };
  const walk = (node: React.ReactNode): boolean => {
    if (++nodes > MAX_SIGNATURE_NODES) {
      return false;
    }
    if (Array.isArray(node)) {
      mix('[');
      return node.every(walk);
    }
    if (!React.isValidElement(node)) {
      mix(`${typeof node}:${String(node)}`);
      return true;
    }
    const type = node.type as string | object;
    if (typeof type === 'string') {
      mix(type);
    } else {
      let id = typeIds.get(type);
      if (id == null) {
        id = nextTypeId++;
        typeIds.set(type, id);
      }
      mix(`#${id}`);
    }
    const { children: inner, ...props } = node.props as Record<string, unknown>;
    for (const name in props) {
      const value = props[name];
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        mix(`${name}=${value}`);
      }
    }
    mix('>');
    return walk(inner as React.ReactNode);
  };
  mix(`${fitWidth}:${typeof width === 'number' ? width : ''}`);
  return walk(children) ? `${a >>> 0}.${b >>> 0}` : null;
}

let nextRootId = 1 + Math.floor(Math.random() * 0x3fffff) * 256;

function NativeRootInner({
  children,
  fitWidth,
  ...viewProps
}: NativeRootProps) {
  const Bridge = useContextBridge();
  const [rootId] = React.useState(() => nextRootId++);
  const [failure, setFailure] = React.useState<{ error: unknown } | null>(null);
  const handle = React.useRef<NativeRootHandle | null>(null);

  if (failure != null) {
    throw failure.error;
  }

  const flat = StyleSheet.flatten(viewProps.style);
  const autoHeight = flat?.height == null;
  const autoWidth = fitWidth === true && flat?.width == null;
  const flatWidth = flat?.width;
  const sizeKey = React.useMemo(
    () =>
      autoHeight
        ? childrenSignature(children, fitWidth === true, flatWidth)
        : null,
    [autoHeight, children, fitWidth, flatWidth],
  );
  const key = React.useRef<string | null>(null);
  const [hint] = React.useState(() =>
    sizeKey != null ? rememberedSizes.get(sizeKey) : undefined,
  );

  React.useLayoutEffect(() => {
    handle.current = createNativeRoot(rootId, error => setFailure({ error }));
    if (autoHeight) {
      handle.current.setAutoHeight();
    }
    if (autoWidth) {
      handle.current.setAutoWidth();
    }
    return () => {
      handle.current?.unmount();
      handle.current = null;
    };
  }, [rootId, autoHeight, autoWidth]);

  const [slots, setSlots] = React.useState<ReadonlyMap<number, SlotContent>>(
    () => new Map(),
  );
  const api = React.useMemo<SlotApi>(() => {
    let nextSlotId = 1;
    return {
      rootId,
      allocate: () => nextSlotId++,
      set(slotId, content) {
        setSlots(previous => {
          const current = previous.get(slotId);
          if (
            current != null &&
            current.children === content.children &&
            current.style === content.style
          ) {
            return previous;
          }
          const next = new Map(previous);
          next.set(slotId, content);
          return next;
        });
      },
      remove(slotId) {
        setSlots(previous => {
          if (!previous.has(slotId)) {
            return previous;
          }
          const next = new Map(previous);
          next.delete(slotId);
          return next;
        });
      },
    };
  }, [rootId]);

  React.useLayoutEffect(() => {
    key.current = sizeKey;
    handle.current?.render(
      <FiberProvider>
        <Bridge>
          <SlotContext.Provider value={api}>{children}</SlotContext.Provider>
        </Bridge>
      </FiberProvider>,
    );
  });

  const onNativeEvent = React.useCallback(
    (event: {
      nativeEvent: { id: number; name: string; payload?: unknown };
    }) => {
      const { id, name, payload } = event.nativeEvent;
      if (id === 0 && name === '__contentSize') {
        if (key.current != null) {
          remember(key.current, payload as RememberedSize);
        }
        return;
      }
      handle.current?.dispatch(event.nativeEvent);
    },
    [],
  );

  return (
    <DesktopNativeRootNativeComponent
      {...viewProps}
      rootId={rootId}
      hintHeight={hint?.height}
      hintWidth={autoWidth ? hint?.width : undefined}
      hintMinWidth={autoWidth ? hint?.minWidth : undefined}
      onNativeEvent={onNativeEvent}
    >
      {Array.from(slots, ([slotId, content]) => (
        <DesktopNativeSlotNativeComponent
          key={slotId}
          rootId={rootId}
          slotId={slotId}
          style={[{ position: 'absolute', left: 0, top: 0 }, content.style]}
        >
          {content.children}
        </DesktopNativeSlotNativeComponent>
      ))}
    </DesktopNativeRootNativeComponent>
  );
}

export function NativeRoot(props: NativeRootProps) {
  return (
    <FiberProvider>
      <NativeRootInner {...props} />
    </FiberProvider>
  );
}
