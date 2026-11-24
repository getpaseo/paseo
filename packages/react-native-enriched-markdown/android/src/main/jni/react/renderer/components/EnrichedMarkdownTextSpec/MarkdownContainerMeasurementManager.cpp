#include "MarkdownContainerMeasurementManager.h"
#include "conversions.h"

#include <fbjni/fbjni.h>
#include <react/jni/ReadableNativeMap.h>
#include <react/renderer/core/conversions.h>

using namespace facebook::jni;

namespace facebook::react {

Size MarkdownContainerMeasurementManager::measure(SurfaceId surfaceId, int viewTag, const EnrichedMarkdownProps &props,
                                                  LayoutConstraints layoutConstraints) const {
  const jni::global_ref<jobject> &fabricUIManager = contextContainer_->at<jni::global_ref<jobject>>("FabricUIManager");

  static const auto measure =
      facebook::jni::findClassStatic("com/facebook/react/fabric/FabricUIManager")
          ->getMethod<jlong(jint, jstring, ReadableMap::javaobject, ReadableMap::javaobject, ReadableMap::javaobject,
                            jfloat, jfloat, jfloat, jfloat)>("measure");

  auto minimumSize = layoutConstraints.minimumSize;
  auto maximumSize = layoutConstraints.maximumSize;

  local_ref<JString> componentName = make_jstring("EnrichedMarkdown");

  // Prepare extraData map with viewTag
  folly::dynamic extraData = folly::dynamic::object();
  extraData["viewTag"] = viewTag;
  local_ref<ReadableNativeMap::javaobject> extraDataRNM = ReadableNativeMap::newObjectCxxArgs(extraData);
  local_ref<ReadableMap::javaobject> extraDataRM =
      make_local(reinterpret_cast<ReadableMap::javaobject>(extraDataRNM.get()));

  // Serialize props for measurement
  auto serializedProps = toDynamic(props);
  local_ref<ReadableNativeMap::javaobject> propsRNM = ReadableNativeMap::newObjectCxxArgs(serializedProps);
  local_ref<ReadableMap::javaobject> propsRM = make_local(reinterpret_cast<ReadableMap::javaobject>(propsRNM.get()));

  auto measurement = yogaMeassureToSize(measure(fabricUIManager, surfaceId, componentName.get(), extraDataRM.get(),
                                                propsRM.get(), nullptr, minimumSize.width, maximumSize.width,
                                                minimumSize.height, maximumSize.height));

  return measurement;
}

} // namespace facebook::react
