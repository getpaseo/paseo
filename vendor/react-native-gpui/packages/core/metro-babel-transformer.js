/**
 * React Native's Babel transformer with Flow enums turned into runtime objects
 * before the preset's own plugins run.
 *
 * `@react-native/babel-preset` lists `babel-plugin-transform-flow-enums` after
 * `@babel/plugin-transform-flow-strip-types`, and the strip plugin removes an
 * `export enum` first, so a module such as `VirtualView` loses its enums and
 * fails at run time with a ReferenceError. App-level plugins run ahead of the
 * preset's.
 */
const path = require('path');
const upstream = require('@react-native/metro-babel-transformer');

const presetDir = path.dirname(
  require.resolve('@react-native/babel-preset/package.json'),
);
const flowEnums = require(
  require.resolve('babel-plugin-transform-flow-enums', { paths: [presetDir] }),
);

module.exports = {
  ...upstream,
  transform: args =>
    upstream.transform({
      ...args,
      plugins: [...(args.plugins ?? []), flowEnums],
    }),
  getCacheKey: () =>
    `${upstream.getCacheKey?.() ?? ''}$${require('crypto')
      .createHash('sha1')
      .update(
        require('fs').readFileSync(
          path.join(__dirname, 'metro-babel-transformer.js'),
        ),
      )
      .digest('hex')}`,
};
