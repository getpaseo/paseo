import * as React from 'react';
import { describe, expect, test } from 'vitest';
import { createNativeRoot } from './src-gpui/src/private/desktop/nativeRoot/reconciler';

const h = React.createElement;

function start() {
  const batches: unknown[][] = [];
  const errors: unknown[] = [];
  const root = createNativeRoot(
    7,
    error => errors.push(error),
    (_id, payload) => {
      if (payload !== 'destroy') {
        batches.push(JSON.parse(payload));
      }
    },
  );
  return { root, batches, errors };
}

describe('the native root reconciler', () => {
  test('the first commit is one batch that creates the container, the tree and its links', () => {
    const { root, batches } = start();
    root.render(
      h(
        'Panel',
        { title: 'a' },
        h('Label', { text: 'x' }),
        h('Label', { text: 'y' }),
      ),
    );
    expect(batches).toHaveLength(1);
    const ops = batches[0] as unknown[][];
    expect(ops[0]).toEqual(['create', 1, 'NativeRootContainer', {}]);
    const kinds = ops.map(op => op[0]);
    expect(kinds.filter(kind => kind === 'create')).toHaveLength(4);
    expect(kinds.filter(kind => kind === 'append')).toHaveLength(3);
    expect(
      ops.find(op => op[0] === 'create' && op[2] === 'Panel')?.[3],
    ).toEqual({
      title: 'a',
    });
  });

  test('an update sends only the props that changed, and nothing when none did', () => {
    const { root, batches } = start();
    root.render(h('Label', { text: 'x', size: 3 }));
    root.render(h('Label', { text: 'y', size: 3 }));
    expect(batches[1]).toEqual([
      ['update', expect.any(Number), { text: 'y' }, []],
    ]);
    root.render(h('Label', { text: 'y', size: 3 }));
    expect(batches).toHaveLength(2);
    root.render(h('Label', { text: 'y' }));
    expect(batches[2]).toEqual([['update', expect.any(Number), {}, ['size']]]);
  });

  test('a keyed reorder moves existing instances and a removal removes one, by the same ids', () => {
    const { root, batches } = start();
    const list = (keys: string[]) =>
      h('Panel', null, ...keys.map(key => h('Label', { key, text: key })));
    const children = new Map<number, number[]>();
    const names = new Map<number, string>();
    const apply = (ops: unknown[][]) => {
      for (const op of ops) {
        const [kind, a, b, c] = op as [
          string,
          number,
          number | string,
          unknown,
        ];
        if (kind === 'create') {
          names.set(a, (c as { text?: string }).text ?? String(b));
        } else if (kind === 'append' || kind === 'insert') {
          for (const list of children.values()) {
            const at = list.indexOf(b as number);
            if (at >= 0) list.splice(at, 1);
          }
          const list = children.get(a) ?? [];
          const before = kind === 'insert' ? list.indexOf(c as number) : -1;
          list.splice(before < 0 ? list.length : before, 0, b as number);
          children.set(a, list);
        } else if (kind === 'remove') {
          children.set(
            a,
            (children.get(a) ?? []).filter(id => id !== b),
          );
        }
      }
    };
    const order = () => {
      const panel = [...names.entries()].find(
        ([, name]) => name === 'Panel',
      )?.[0];
      return (children.get(panel!) ?? []).map(id => names.get(id));
    };
    root.render(list(['a', 'b', 'c']));
    apply(batches[0] as unknown[][]);
    expect(order()).toEqual(['a', 'b', 'c']);
    const created = (batches[0] as unknown[][]).filter(
      op => op[0] === 'create',
    );
    root.render(list(['c', 'a', 'b']));
    apply(batches[1] as unknown[][]);
    expect(order()).toEqual(['c', 'a', 'b']);
    expect((batches[1] as unknown[][]).every(op => op[0] !== 'create')).toBe(
      true,
    );
    root.render(list(['c', 'b']));
    apply(batches[2] as unknown[][]);
    expect(order()).toEqual(['c', 'b']);
    expect(batches[2]).toEqual([
      [
        'remove',
        expect.any(Number),
        created.find(op => (op[3] as { text?: string }).text === 'a')?.[1],
      ],
    ]);
  });

  test('a handler stays here: the runtime gets true, and the event calls the latest one', () => {
    const { root, batches } = start();
    const calls: string[] = [];
    root.render(h('Button', { onPress: () => calls.push('first') }));
    const create = (batches[0] as unknown[][]).find(op => op[2] === 'Button')!;
    expect(create[3]).toEqual({ onPress: true });
    root.render(
      h('Button', {
        onPress: (payload: unknown) => calls.push(`second ${payload}`),
      }),
    );
    expect(batches).toHaveLength(1);
    root.dispatch({ id: create[1] as number, name: 'onPress', payload: 5 });
    expect(calls).toEqual(['second 5']);
    root.dispatch({ id: 999, name: 'onPress' });
  });

  test('a state update inside the tree sends its own batch', async () => {
    const { root, batches } = start();
    let bump: () => void = () => {};
    function Counter() {
      const [count, setCount] = React.useState(0);
      bump = () => setCount(value => value + 1);
      return h('Label', { text: `n${count}` });
    }
    root.render(h(Counter));
    expect(batches).toHaveLength(1);
    bump();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([
      ['update', expect.any(Number), { text: 'n1' }, []],
    ]);
  });

  test('a component that throws while rendering reports it', async () => {
    const { root, errors } = start();
    function Broken(): never {
      throw new Error('boom');
    }
    try {
      root.render(h(Broken));
    } catch {
      // the error is also reported through onError
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(errors.length).toBeGreaterThan(0);
  });

  test('text directly in the tree is refused with a message that says why', async () => {
    const { root, errors } = start();
    try {
      root.render(h('Panel', null, 'loose text'));
    } catch {
      // reported through onError as well
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(String(errors[0])).toContain(
      'Text is not allowed directly inside a NativeRoot',
    );
  });
});

describe('image props of a native tree', () => {
  test('are left as they are where React Native is not available to resolve them', async () => {
    const { resolveImageProps } =
      await import('./src-gpui/src/private/desktop/nativeRoot/imageProps');
    const props = { icon: { uri: 'file:///x.png' }, title: 't' };
    expect(resolveImageProps('Anything', props)).toBe(props);
  });
});
