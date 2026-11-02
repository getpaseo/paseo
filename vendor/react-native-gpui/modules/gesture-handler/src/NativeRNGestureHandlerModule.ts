import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  createGestureHandler: (
    handlerName: string,
    handlerTag: CodegenTypes.Double,
    config: Object,
  ) => void;
  attachGestureHandler: (
    handlerTag: CodegenTypes.Double,
    viewTag: CodegenTypes.Double,
    actionType: CodegenTypes.Double,
  ) => void;
  setGestureHandlerConfig: (
    handlerTag: CodegenTypes.Double,
    newConfig: Object,
  ) => void;
  updateGestureHandlerConfig: (
    handlerTag: CodegenTypes.Double,
    newConfig: Object,
  ) => void;
  configureRelations: (
    handlerTag: CodegenTypes.Double,
    relations: Object,
  ) => void;
  dropGestureHandler: (handlerTag: CodegenTypes.Double) => void;
  flushOperations: () => void;
  installUIRuntimeBindings: () => boolean;
}

export default TurboModuleRegistry.getEnforcing<Spec>('RNGestureHandlerModule');
