#include "layout.h"
#include <jni.h>
#include <chrono>
#include <cmath>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include "include/ports/SkFontMgr_android.h"
#include "modules/skunicode/include/SkUnicode.h"

namespace {
using Clock = std::chrono::steady_clock;
using paseo::diff::Document;
struct Job {
  std::atomic<bool> cancelled{false};
  std::atomic<bool> started{false};
  std::shared_ptr<const Document> document;
};
std::mutex mutex;
std::unordered_map<uint64_t, std::shared_ptr<Job>> jobs;
uint64_t nextId = 0;

double elapsed(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}
std::shared_ptr<Job> findJob(double id) {
  std::lock_guard lock(mutex);
  const auto found = jobs.find(static_cast<uint64_t>(id));
  if (found == jobs.end()) throw std::runtime_error("Unknown or released layout");
  return found->second;
}
std::u16string copyString(JNIEnv* env, jstring source) {
  if (!source) throw std::runtime_error("Missing text");
  const jsize length = env->GetStringLength(source);
  const jchar* chars = env->GetStringChars(source, nullptr);
  if (!chars) throw std::runtime_error("Could not copy text");
  std::u16string result(reinterpret_cast<const char16_t*>(chars), length);
  env->ReleaseStringChars(source, chars);
  return result;
}
jdoubleArray numbers(JNIEnv* env, const std::vector<double>& values) {
  auto result = env->NewDoubleArray(values.size());
  if (result) env->SetDoubleArrayRegion(result, 0, values.size(), values.data());
  return result;
}
void fail(JNIEnv* env, const std::exception& error) {
  env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
}
}  // namespace

#define METHOD(name) Java_sh_paseo_diffprototype_PaseoDiffPrototypeModule_##name

extern "C" JNIEXPORT jdouble JNICALL METHOD(createDocument)(JNIEnv*, jobject) {
  std::lock_guard lock(mutex);
  const auto id = ++nextId;
  jobs.emplace(id, std::make_shared<Job>());
  return id;
}

extern "C" JNIEXPORT jdoubleArray JNICALL METHOD(prepareDocument)(
    JNIEnv* env, jobject, jdouble id, jobjectArray texts, jdoubleArray widths,
    jstring family, jdouble size) {
  try {
    auto job = findJob(id);
    if (job->started.exchange(true)) throw std::runtime_error("Layout already started");
    const auto copyStart = Clock::now();
    const jsize count = env->GetArrayLength(texts);
    if (count > 100000 || env->GetArrayLength(widths) != count || !std::isfinite(size) || size <= 0 || size > 100)
      throw std::runtime_error("Invalid layout input");
    std::vector<double> available(count);
    env->GetDoubleArrayRegion(widths, 0, count, available.data());
    auto document = std::make_shared<Document>();
    document->cells.reserve(count);
    size_t units = 0;
    for (jsize i = 0; i < count; i++) {
      if (job->cancelled.load()) throw std::runtime_error("Layout cancelled");
      if (!std::isfinite(available[i]) || available[i] <= 0) throw std::runtime_error("Invalid width");
      auto text = static_cast<jstring>(env->GetObjectArrayElement(texts, i));
      auto copied = copyString(env, text);
      env->DeleteLocalRef(text);
      units += copied.size();
      if (units > 16000000) throw std::runtime_error("Prototype input limit exceeded");
      document->cells.push_back({std::move(copied), available[i], {}});
    }
    const auto fontFamily = SkUnicode::convertUtf16ToUtf8(copyString(env, family));
    const double copyMs = elapsed(copyStart);
    const auto layoutStart = Clock::now();
    paseo::diff::prepare(*document, SkFontMgr_New_Android(nullptr), fontFamily.c_str(), size, job->cancelled);
    const double layoutMs = elapsed(layoutStart);
    {
      std::lock_guard lock(mutex);
      if (job->cancelled.load()) throw std::runtime_error("Layout cancelled");
      job->document = document;
    }
    return numbers(env, {static_cast<double>(document->cells.size()),
      static_cast<double>(document->fragmentCount), static_cast<double>(document->graphemeCount),
      copyMs, layoutMs, static_cast<double>(document->geometryBytes)});
  } catch (const std::exception& error) {
    fail(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT jdoubleArray JNICALL METHOD(readDocument)(
    JNIEnv* env, jobject, jdouble id, jint start, jint count) {
  try {
    const auto job = findJob(id);
    std::shared_ptr<const Document> document;
    {
      std::lock_guard lock(mutex);
      document = job->document;
    }
    if (!document) throw std::runtime_error("Layout is not ready");
    if (start < 0 || count < 0 || count > 256 || static_cast<size_t>(start) > document->cells.size())
      throw std::runtime_error("Invalid viewport range");
    return numbers(env, paseo::diff::read(*document, start, count));
  } catch (const std::exception& error) {
    fail(env, error);
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL METHOD(releaseDocument)(JNIEnv*, jobject, jdouble id) {
  std::lock_guard lock(mutex);
  const auto found = jobs.find(static_cast<uint64_t>(id));
  if (found == jobs.end()) return;
  found->second->cancelled.store(true);
  jobs.erase(found);
}

extern "C" JNIEXPORT void JNICALL METHOD(releaseAllDocuments)(JNIEnv*, jobject) {
  std::lock_guard lock(mutex);
  for (auto& [id, job] : jobs) job->cancelled.store(true);
  jobs.clear();
}
