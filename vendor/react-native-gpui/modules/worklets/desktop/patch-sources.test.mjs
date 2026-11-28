import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { applyHunks, parsePatch } from './patch-sources.mjs';

const PATCH = `--- a/lib/a.cpp
+++ b/lib/a.cpp
@@ -1,3 +1,4 @@
 #include <a>
+#include <b>

 int main() {}
`;

describe('parsePatch', () => {
  test('reads each file and its hunks, including blank context lines', () => {
    const [file] = parsePatch(PATCH);
    expect(file.path).toBe('lib/a.cpp');
    expect(file.hunks).toEqual([
      {
        start: 1,
        old: ['#include <a>', '', 'int main() {}'],
        new: ['#include <a>', '#include <b>', '', 'int main() {}'],
      },
    ]);
  });
});

describe('applyHunks', () => {
  const [{ hunks }] = parsePatch(PATCH);

  test('applies a hunk', () => {
    expect(applyHunks('#include <a>\n\nint main() {}\n', hunks, 'a')).toBe(
      '#include <a>\n#include <b>\n\nint main() {}\n',
    );
  });

  test('finds a hunk that moved', () => {
    expect(
      applyHunks('// x\n// y\n#include <a>\n\nint main() {}\n', hunks, 'a'),
    ).toBe('// x\n// y\n#include <a>\n#include <b>\n\nint main() {}\n');
  });

  test('leaves sources that already carry the change alone', () => {
    const patched = '#include <a>\n#include <b>\n\nint main() {}\n';
    expect(applyHunks(patched, hunks, 'a')).toBe(patched);
  });

  test('ignores CRLF in the patch and keeps CRLF in the source', () => {
    const [{ hunks: crlfHunks }] = parsePatch(PATCH.replace(/\n/gu, '\r\n'));
    expect(
      applyHunks('#include <a>\r\n\r\nint main() {}\r\n', crlfHunks, 'a'),
    ).toBe('#include <a>\r\n#include <b>\r\n\r\nint main() {}\r\n');
  });

  test('rejects sources it does not match', () => {
    expect(() => applyHunks('int main() { return 1; }\n', hunks, 'a')).toThrow(
      'a: hunk at line 1 does not apply',
    );
  });
});

describe('the shipped patches', () => {
  const root = path.resolve(import.meta.dirname, '../../..');

  test.each([
    ['react-native-worklets', 'modules/worklets/desktop/patches'],
    ['react-native-reanimated', 'modules/reanimated/desktop/patches'],
  ])('apply to the installed %s', (name, patches) => {
    const source = path.join(root, 'node_modules', name, 'Common', 'cpp');
    for (const patchFile of fs.readdirSync(path.join(root, patches))) {
      const text = fs.readFileSync(path.join(root, patches, patchFile), 'utf8');
      for (const file of parsePatch(text)) {
        const original = fs.readFileSync(path.join(source, file.path), 'utf8');
        expect(() => applyHunks(original, file.hunks, file.path)).not.toThrow();
      }
    }
  });
});
