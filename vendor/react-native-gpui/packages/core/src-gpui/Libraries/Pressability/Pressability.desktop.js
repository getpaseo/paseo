// Components spread these handlers after their own props
// (`<View {...props} {...handlers}>`), so a key set to `undefined` here, as
// `onPointerEnter` is for a Pressable without `onHoverIn`, erases the
// component's own handler. Only the handlers that exist are returned.
import UpstreamPressability from './Pressability';

export default class Pressability extends UpstreamPressability {
  _createEventHandlers() {
    const handlers = super._createEventHandlers();
    const defined = {};
    for (const key of Object.keys(handlers)) {
      if (handlers[key] != null) defined[key] = handlers[key];
    }
    return defined;
  }
}
