/**
 * The renderer entry points, with one change: a command sent to a ref of an
 * instance of a native tree (a component inside a `NativeRoot`) goes to the
 * instance instead of to a Fabric node, so the `Commands` of a spec work on
 * either kind of ref.
 */
import { dispatchCommand as fabricDispatchCommand } from './RendererImplementation';

export * from './RendererImplementation';

export function dispatchCommand(handle, command, args) {
  if (handle != null && handle.__nativeTreeInstance === true) {
    handle.command(command, ...args);
    return;
  }
  fabricDispatchCommand(handle, command, args);
}
