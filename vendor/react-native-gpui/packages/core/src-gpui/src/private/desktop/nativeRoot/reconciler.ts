/**
 * The second reconciler: it renders React elements whose types are strings
 * into a native tree held by the runtime, as batches of operations.
 *
 * Nothing here creates a Fabric node. An element's type names a component
 * registered natively, its props that are not functions go to the runtime as
 * data, and the functions stay here, called when the instance sends the event
 * of the same name. One commit makes one call to `__gpuiNativeRootApply`.
 *
 * @format
 */

import * as React from 'react';
import { resolveImageProps } from './imageProps';
import Reconciler from 'react-reconciler';
import * as constants from 'react-reconciler/constants';

type Props = Record<string, unknown>;

const { DefaultEventPriority, NoEventPriority } = constants as unknown as {
  DefaultEventPriority: number;
  NoEventPriority: number;
};

type ReconcilerApi = {
  createContainer(...args: unknown[]): unknown;
  updateContainerSync(
    element: unknown,
    container: unknown,
    parent: unknown,
    callback: unknown,
  ): void;
  flushSyncWork(): void;
};

type RootState = {
  batch: Batch;
  byId: Map<number, NativeInstance>;
  /** Sends what the last commit changed. */
  flush: () => void;
};

export type NativeInstance = {
  id: number;
  type: string;
  props: Props;
  handlers: Record<string, (payload: unknown) => void>;
  parent: NativeInstance | null;
  root: RootState;
  /** Tells `Commands.*` of a spec that this ref is not a Fabric node's. */
  readonly __nativeTreeInstance: true;
  /**
   * Calls the command `name` of the instance in the runtime, as a ref to a
   * Fabric host component's `dispatchCommand` does.
   */
  command(name: string, ...args: unknown[]): void;
};

type Op = unknown[];

/** What the last commit of any native root cost, for measuring. */
export const nativeRootStats = { ops: 0, bytes: 0, ms: 0 };

export type NativeRootHandle = {
  readonly rootId: number;
  render(element: React.ReactNode): void;
  dispatch(event: { id: number; name: string; payload?: unknown }): void;
  /** Size the box to the height of the tree's content. */
  setAutoHeight(): void;
  /** Size the box to the width of the tree's content. */
  setAutoWidth(): void;
  unmount(): void;
};

type Apply = (rootId: number, payload: string) => void;

declare const globalThis: { __gpuiNativeRootApply?: Apply };
declare const __DEV__: boolean | undefined;

const CONTAINER_TYPE = 'NativeRootContainer';

/** React reads a host context at every host node and refuses a missing one. */
const HOST_CONTEXT = {};

let nextInstanceId = 2;
let currentPriority = NoEventPriority;

function isHandler(value: unknown): value is (payload: unknown) => void {
  return typeof value === 'function';
}

/** What goes to the runtime: data props as they are, handlers as `true`. */
function wire(
  type: string,
  rawProps: Props,
): {
  data: Props;
  handlers: NativeInstance['handlers'];
} {
  const props = resolveImageProps(type, rawProps);
  const data: Props = {};
  const handlers: NativeInstance['handlers'] = {};
  for (const name of Object.keys(props)) {
    if (name === 'children' || name === 'key' || name === 'ref') {
      continue;
    }
    const value = props[name];
    if (value === undefined) {
      continue;
    }
    if (isHandler(value)) {
      handlers[name] = value;
      data[name] = true;
    } else {
      data[name] = value;
    }
  }
  return { data, handlers };
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

class Batch {
  ops: Op[] = [];
}

function createHostConfig() {
  const append = (parent: NativeInstance, child: NativeInstance) => {
    child.parent = parent;
    parent.root.batch.ops.push(['append', parent.id, child.id]);
  };
  const detach = (parent: NativeInstance, child: NativeInstance) => {
    parent.root.batch.ops.push(['remove', parent.id, child.id]);
    child.parent = null;
  };
  const insertBefore = (
    parent: NativeInstance,
    child: NativeInstance,
    before: NativeInstance,
  ) => {
    child.parent = parent;
    parent.root.batch.ops.push(['insert', parent.id, child.id, before.id]);
  };

  return {
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    isPrimaryRenderer: false,
    noTimeout: -1,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    scheduleMicrotask: (callback: () => void) => {
      Promise.resolve().then(callback);
    },

    createInstance(
      type: string,
      props: Props,
      container: NativeInstance,
    ): NativeInstance {
      const { data, handlers } = wire(type, props);
      const instance: NativeInstance = {
        id: nextInstanceId++,
        type,
        props: data,
        handlers,
        parent: null,
        root: container.root,
        __nativeTreeInstance: true,
        command(name, ...args) {
          instance.root.batch.ops.push(['command', instance.id, name, args]);
          instance.root.flush();
        },
      };
      container.root.byId.set(instance.id, instance);
      container.root.batch.ops.push(['create', instance.id, type, data]);
      return instance;
    },
    createTextInstance(): never {
      throw new Error(
        'Text is not allowed directly inside a NativeRoot: wrap it in a component that takes it as a prop.',
      );
    },
    appendInitialChild: append,
    appendChild: append,
    appendChildToContainer: (
      container: NativeInstance,
      child: NativeInstance,
    ) => append(container, child),
    insertBefore,
    insertInContainerBefore: insertBefore,
    removeChild: detach,
    removeChildFromContainer: detach,
    commitUpdate(
      instance: NativeInstance,
      _type: string,
      _oldProps: Props,
      newProps: Props,
    ) {
      const { data, handlers } = wire(instance.type, newProps);
      instance.handlers = handlers;
      const set: Props = {};
      const unset: string[] = [];
      for (const name of Object.keys(data)) {
        if (!same(instance.props[name], data[name])) {
          set[name] = data[name];
        }
      }
      for (const name of Object.keys(instance.props)) {
        if (!(name in data)) {
          unset.push(name);
        }
      }
      instance.props = data;
      if (unset.length > 0 || Object.keys(set).length > 0) {
        instance.root.batch.ops.push(['update', instance.id, set, unset]);
      }
    },
    finalizeInitialChildren: () => false,
    shouldSetTextContent: () => false,
    getRootHostContext: () => HOST_CONTEXT,
    getChildHostContext: (context: unknown) => context,
    getPublicInstance: (instance: NativeInstance) => instance,
    prepareForCommit: () => null,
    resetAfterCommit(container: NativeInstance) {
      container.root.flush();
    },
    preparePortalMount() {},
    clearContainer() {},
    detachDeletedInstance(instance: NativeInstance) {
      instance.root.byId.delete(instance.id);
    },
    hideInstance() {},
    unhideInstance() {},
    hideTextInstance() {},
    unhideTextInstance() {},
    commitTextUpdate() {},
    resetTextContent() {},
    getInstanceFromNode: () => null,
    getInstanceFromScope: () => null,
    beforeActiveInstanceBlur() {},
    afterActiveInstanceBlur() {},
    prepareScopeUpdate() {},
    requestPostPaintCallback() {},
    resetFormInstance() {},
    shouldAttemptEagerTransition: () => false,
    trackSchedulerEvent() {},
    resolveEventType: () => null,
    resolveEventTimeStamp: () => -1.1,
    maySuspendCommit: () => false,
    preloadInstance: () => true,
    startSuspendingCommit() {},
    suspendInstance() {},
    waitForCommitToBeReady: () => null,
    NotPendingTransition: null,
    HostTransitionContext: React.createContext(null),
    setCurrentUpdatePriority(priority: number) {
      currentPriority = priority;
    },
    getCurrentUpdatePriority: () => currentPriority,
    resolveUpdatePriority: () =>
      currentPriority !== NoEventPriority
        ? currentPriority
        : DefaultEventPriority,
  };
}

let reconciler: ReconcilerApi | undefined;

/**
 * One reconciler for every tree, so React's developer tools and Fast Refresh
 * see a single renderer: an edit to a component of a tree re-renders it with
 * its state kept.
 */
function sharedReconciler(): ReconcilerApi {
  if (reconciler == null) {
    const created = Reconciler(
      createHostConfig() as never,
    ) as unknown as ReconcilerApi & {
      injectIntoDevTools(config: unknown): boolean;
    };
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      created.injectIntoDevTools({
        bundleType: 1,
        version: React.version,
        rendererPackageName: 'gpui-native-root',
        findFiberByHostInstance: () => null,
      });
    }
    reconciler = created;
  }
  return reconciler;
}

/**
 * Starts a tree. `onError` gets what a component of the tree throws while it
 * renders, so the caller can throw it again in the outer tree, where React
 * Native reports it like any render error.
 */
export function createNativeRoot(
  rootId: number,
  onError: (error: unknown) => void,
  apply: Apply | undefined = globalThis.__gpuiNativeRootApply,
): NativeRootHandle {
  const state: RootState = {
    batch: new Batch(),
    byId: new Map(),
    flush: () => {},
  };
  const { batch, byId } = state;
  const container: NativeInstance = {
    id: 1,
    type: CONTAINER_TYPE,
    props: {},
    handlers: {},
    parent: null,
    root: state,
    __nativeTreeInstance: true,
    command() {},
  };
  byId.set(container.id, container);
  const reconciler = sharedReconciler();
  const fiberRoot = reconciler.createContainer(
    container,
    1,
    null,
    false,
    null,
    `native-root-${rootId}`,
    onError,
    onError,
    onError,
    () => {},
    null,
  );

  let started = false;
  const flush = () => {
    if (!started) {
      batch.ops.unshift(['create', container.id, CONTAINER_TYPE, {}]);
      started = true;
    }
    if (batch.ops.length > 0 && apply != null) {
      const ops = batch.ops;
      batch.ops = [];
      const payload = JSON.stringify(ops);
      nativeRootStats.ops = ops.length;
      nativeRootStats.bytes = payload.length;
      apply(rootId, payload);
    }
  };

  state.flush = flush;

  return {
    rootId,
    render(element) {
      const started = Date.now();
      reconciler.updateContainerSync(element, fiberRoot, null, null);
      reconciler.flushSyncWork();
      flush();
      nativeRootStats.ms = Date.now() - started;
    },
    dispatch(event) {
      const instance = byId.get(event.id);
      instance?.handlers[event.name]?.(event.payload);
    },
    setAutoHeight() {
      apply?.(rootId, 'auto-height');
    },
    setAutoWidth() {
      apply?.(rootId, 'auto-width');
    },
    unmount() {
      reconciler.updateContainerSync(null, fiberRoot, null, null);
      reconciler.flushSyncWork();
      batch.ops = [];
      apply?.(rootId, 'destroy');
    },
  };
}
