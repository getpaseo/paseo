package sh.paseo.scroll;

import android.content.Context;
import com.facebook.react.bridge.BridgeReactContext;
import com.facebook.react.bridge.UIManager;
import com.facebook.react.bridge.UIManagerListener;
import com.facebook.react.uimanager.events.EventDispatcher;
import com.facebook.react.uimanager.events.EventDispatcherProvider;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;

/**
 * A React context with a running Fabric UIManager, so scroll views find the mount listener
 * registry and event dispatcher the way they do in the app. The UIManager only records mount
 * listeners and the dispatcher drops events; every other call returns a default. Java, because
 * {@link EventDispatcherProvider} is internal to React Native's Kotlin module.
 */
final class MountingReactContext extends BridgeReactContext implements EventDispatcherProvider {
  final List<UIManagerListener> mountListeners = new ArrayList<>();
  final UIManager uiManager;
  private final EventDispatcher eventDispatcher = inert(EventDispatcher.class, null);

  MountingReactContext(Context base) {
    super(base);
    uiManager = inert(UIManager.class, this);
  }

  /** Runs one Fabric mount: listeners see willMountItems, then the change, then didMountItems. */
  void mount(Runnable change) {
    for (UIManagerListener listener : new ArrayList<>(mountListeners)) listener.willMountItems(uiManager);
    change.run();
    for (UIManagerListener listener : new ArrayList<>(mountListeners)) listener.didMountItems(uiManager);
  }

  @Override
  public boolean hasActiveReactInstance() {
    return true;
  }

  @Override
  public UIManager getFabricUIManager() {
    return uiManager;
  }

  @Override
  public EventDispatcher getEventDispatcher() {
    return eventDispatcher;
  }

  private static <T> T inert(Class<T> type, MountingReactContext owner) {
    return type.cast(
        Proxy.newProxyInstance(
            type.getClassLoader(),
            new Class<?>[] {type},
            (proxy, method, args) -> {
              switch (method.getName()) {
                case "addUIManagerEventListener":
                  owner.mountListeners.add((UIManagerListener) args[0]);
                  return null;
                case "removeUIManagerEventListener":
                  owner.mountListeners.remove((UIManagerListener) args[0]);
                  return null;
                case "getEventDispatcher":
                  return owner.eventDispatcher;
                default:
                  Class<?> result = method.getReturnType();
                  if (result == boolean.class) return false;
                  if (result == int.class) return 0;
                  if (result == long.class) return 0L;
                  if (result == float.class) return 0f;
                  if (result == double.class) return 0.0;
                  return null;
              }
            }));
  }
}
