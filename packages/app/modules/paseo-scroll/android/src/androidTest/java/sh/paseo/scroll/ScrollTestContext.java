package sh.paseo.scroll;

import android.content.Context;
import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.uimanager.events.BlackHoleEventDispatcher;
import com.facebook.react.uimanager.events.EventDispatcher;
import com.facebook.react.uimanager.events.EventDispatcherProvider;

/** Native-only tests use RN's own event sink for a context without JavaScript. */
final class ScrollTestContext extends BridgeReactContext implements EventDispatcherProvider {
  ScrollTestContext(Context context) {
    super(context);
  }

  @Override
  public EventDispatcher getEventDispatcher() {
    return BlackHoleEventDispatcher.INSTANCE;
  }
}
