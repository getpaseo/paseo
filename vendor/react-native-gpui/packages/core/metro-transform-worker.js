/**
 * Metro's own transform worker, except that `Platform.OS` is left alone.
 *
 * Metro always inlines `Platform.OS` and `Platform.select` as the platform it is
 * building for, which is `desktop`. The desktop shell runs on macOS, Windows and
 * Linux from the same bundle, so the operating system is only known at runtime:
 * `Platform.desktop.js` reads it from the shell, and `Platform.OS` has to be that
 * value rather than a constant folded in at build time.
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const metroDir = path.dirname(require.resolve('metro/package.json'));
const worker = require(
  require.resolve('metro-transform-worker', { paths: [metroDir] }),
);

const selfKey = crypto
  .createHash('sha1')
  .update(fs.readFileSync(path.join(__dirname, 'metro-transform-worker.js')))
  .digest('hex');

module.exports = {
  transform: (config, projectRoot, filename, data, options) =>
    worker.transform(config, projectRoot, filename, data, {
      ...options,
      inlinePlatform: false,
    }),
  getCacheKey: (config, opts) =>
    `${worker.getCacheKey(config, opts)}$${selfKey}`,
};
