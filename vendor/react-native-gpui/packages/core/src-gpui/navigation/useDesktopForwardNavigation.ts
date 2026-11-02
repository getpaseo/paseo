import { useEffect, useRef } from 'react';
import { DeviceEventEmitter } from 'react-native';

type Route = {
  key?: string;
  name: string;
  params?: object;
  state?: NavigationState;
};
type NavigationState = {
  key?: string;
  type?: string;
  index?: number;
  routes: readonly Route[];
};
type NavigationRef = {
  addListener(event: 'state', listener: () => void): () => void;
  getRootState(): NavigationState | undefined;
  isReady(): boolean;
  dispatch(action: {
    type: string;
    target?: string;
    payload: { name: string; params?: object };
  }): void;
};

function stackRoutes(state: NavigationState | undefined) {
  const stacks = new Map<string, Route[]>();
  function visit(current: NavigationState) {
    if (
      current.type === 'stack' &&
      current.key &&
      current.index !== undefined
    ) {
      stacks.set(current.key, current.routes.slice(0, current.index + 1));
    }
    for (const route of current.routes) {
      if (route.state) visit(route.state);
    }
  }
  if (state) visit(state);
  return stacks;
}

export function useDesktopForwardNavigation(navigationRef: NavigationRef) {
  const previousStacks = useRef(new Map<string, Route[]>());
  const history = useRef<Array<{ target: string; route: Route }>>([]);
  const applyingForward = useRef(false);

  useEffect(() => {
    const readStacks = () =>
      stackRoutes(
        navigationRef.isReady() ? navigationRef.getRootState() : undefined,
      );
    previousStacks.current = readStacks();
    const removeStateListener = navigationRef.addListener('state', () => {
      const next = readStacks();
      let changedBranch = false;
      for (const [target, routes] of next) {
        const previous = previousStacks.current.get(target);
        if (!previous) continue;
        const isBack =
          routes.length < previous.length &&
          routes.every((route, index) => route.key === previous[index]?.key);
        if (isBack) {
          history.current.unshift(
            ...previous.slice(routes.length).map(route => ({ target, route })),
          );
        } else if (
          routes.length !== previous.length ||
          routes.some((route, index) => route.key !== previous[index]?.key)
        ) {
          changedBranch = true;
        }
      }
      if (changedBranch) {
        if (applyingForward.current) applyingForward.current = false;
        else history.current = [];
      }
      previousStacks.current = next;
    });
    const subscription = DeviceEventEmitter.addListener(
      'hardwareForwardPress',
      () => {
        const stacks = readStacks();
        let entry = history.current.shift();
        while (entry && !stacks.has(entry.target)) {
          entry = history.current.shift();
        }
        if (entry) {
          applyingForward.current = true;
          navigationRef.dispatch({
            type: 'PUSH',
            target: entry.target,
            payload: { name: entry.route.name, params: entry.route.params },
          });
        }
      },
    );
    return () => {
      removeStateListener();
      subscription.remove();
    };
  }, [navigationRef]);
}
