/**
 * @flow strict-local
 * @format
 */

import NativeSettingsManager from './NativeSettingsManager';
import invariant from 'invariant';

const subscriptions: Array<{
  keys: Array<string>,
  callback: ?Function,
  ...
}> = [];

function notify(changed: Array<string>) {
  subscriptions.forEach(subscription => {
    if (
      subscription.callback &&
      changed.some(key => subscription.keys.includes(key))
    ) {
      subscription.callback();
    }
  });
}

/**
 * A persistent key-value store, kept in a JSON file in the app's data
 * directory. Values must survive `JSON.stringify`.
 */
const Settings = {
  _settings: ((NativeSettingsManager &&
    NativeSettingsManager.getConstants().settings) ??
    {}) as { [string]: mixed },

  get(key: string): unknown {
    return this._settings[key];
  },

  set(settings: { [string]: mixed }) {
    const changed = Object.keys(settings).filter(
      key =>
        JSON.stringify(this._settings[key]) !== JSON.stringify(settings[key]),
    );
    this._settings = Object.assign(this._settings, settings);
    NativeSettingsManager?.setValues(settings);
    notify(changed);
  },

  watchKeys(keys: string | Array<string>, callback: Function): number {
    if (typeof keys === 'string') {
      keys = [keys];
    }
    invariant(
      Array.isArray(keys),
      'keys should be a string or array of strings',
    );
    const id = subscriptions.length;
    subscriptions.push({ keys, callback });
    return id;
  },

  clearWatch(watchId: number) {
    if (watchId < subscriptions.length) {
      subscriptions[watchId] = { keys: [], callback: null };
    }
  },
};

export default Settings;
