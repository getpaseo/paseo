/**
 * Share for desktop: the system share sheet where there is one (macOS), and a
 * copy to the clipboard elsewhere.
 *
 * @format
 */

import { TurboModuleRegistry } from 'react-native';

const invariant = require('invariant');

class Share {
  static share(content, options = {}) {
    invariant(
      typeof content === 'object' && content !== null,
      'Content to share must be a valid object',
    );
    invariant(
      typeof content.url === 'string' || typeof content.message === 'string',
      'At least one of URL or message is required',
    );
    invariant(
      typeof options === 'object' && options !== null,
      'Options must be a valid object',
    );
    const native = TurboModuleRegistry.get('GpuiShare');
    const items = {
      message:
        typeof content.message === 'string' ? content.message : undefined,
      url: typeof content.url === 'string' ? content.url : undefined,
      subject: options.subject,
      anchor: typeof options.anchor === 'number' ? options.anchor : undefined,
    };
    return native.share(items).then(result => ({
      activityType: null,
      ...result,
    }));
  }

  static get sharedAction() {
    return 'sharedAction';
  }

  static get dismissedAction() {
    return 'dismissedAction';
  }
}

export default Share;
