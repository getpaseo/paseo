#include <worklets/Tools/PlatformLogger.h>

#include <glog/logging.h>

namespace worklets {

void PlatformLogger::log(const char* str) {
  LOG(INFO) << str;
}

void PlatformLogger::log(const std::string& str) {
  LOG(INFO) << str;
}

void PlatformLogger::log(const double value) {
  LOG(INFO) << value;
}

void PlatformLogger::log(const int value) {
  LOG(INFO) << value;
}

void PlatformLogger::log(const bool value) {
  LOG(INFO) << (value ? "true" : "false");
}

} // namespace worklets
