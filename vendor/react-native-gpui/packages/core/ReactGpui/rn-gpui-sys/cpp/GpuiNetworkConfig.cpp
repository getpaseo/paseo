#include "GpuiNetworkConfig.h"
#include "GpuiNetworkRequest.h"

#include <glog/logging.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>
#include <vector>

#if defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <SystemConfiguration/SCDynamicStoreCopySpecific.h>
#endif

namespace rngpui {

namespace {

struct Endpoint {
  bool direct{false};
  std::string url; // for curl: scheme://host:port
};

struct BypassRule {
  std::string scheme;
  std::string host; // a glob, lower case
  int port{0};
  bool simpleHostnames{false};
  bool cidr{false};
  std::string address;
  int prefix{0};
};

struct Rules {
  std::map<std::string, Endpoint> bySchemeKey; // "http", "https", "*", "socks"
  std::vector<BypassRule> bypass;
};

enum class Mode { System, Direct, Fixed };

struct Config {
  Mode mode{Mode::System};
  Rules fixed;
  std::vector<std::string> doh;
};

std::mutex configMutex;
Config config;

std::string lower(std::string value) {
  std::transform(
      value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
      });
  return value;
}

std::string trim(const std::string& value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) {
    return "";
  }
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::vector<std::string> split(
    const std::string& text,
    const char* separators) {
  std::vector<std::string> parts;
  std::string current;
  for (const char c : text) {
    if (std::string(separators).find(c) != std::string::npos) {
      parts.push_back(current);
      current.clear();
    } else {
      current += c;
    }
  }
  parts.push_back(current);
  return parts;
}

// "[scheme://]host[:port]" as a curl proxy URL. Chromium's "socks" is SOCKS4
// and both SOCKS versions resolve names at the proxy.
std::optional<Endpoint> parseProxyUri(const std::string& text) {
  std::string rest = trim(text);
  std::string scheme = "http";
  const auto marker = rest.find("://");
  if (marker != std::string::npos) {
    scheme = lower(rest.substr(0, marker));
    rest = rest.substr(marker + 3);
  }
  while (!rest.empty() && rest.back() == '/') {
    rest.pop_back();
  }
  if (scheme == "direct") {
    return Endpoint{true, ""};
  }
  if (rest.empty()) {
    return std::nullopt;
  }
  std::string curlScheme;
  int defaultPort = 80;
  if (scheme == "http") {
    curlScheme = "http";
  } else if (scheme == "https") {
    curlScheme = "https";
    defaultPort = 443;
  } else if (scheme == "socks5") {
    curlScheme = "socks5h";
    defaultPort = 1080;
  } else if (scheme == "socks4" || scheme == "socks") {
    curlScheme = "socks4a";
    defaultPort = 1080;
  } else {
    return std::nullopt;
  }
  const bool hasPort = rest.find(':') != std::string::npos &&
      (rest.front() != '[' || rest.find("]:") != std::string::npos);
  return Endpoint{
      false,
      curlScheme + "://" + rest +
          (hasPort ? "" : ":" + std::to_string(defaultPort))};
}

std::optional<BypassRule> parseBypass(std::string pattern) {
  pattern = trim(pattern);
  if (pattern.empty()) {
    return std::nullopt;
  }
  BypassRule rule;
  if (lower(pattern) == "<local>") {
    rule.simpleHostnames = true;
    return rule;
  }
  const auto marker = pattern.find("://");
  if (marker != std::string::npos) {
    rule.scheme = lower(pattern.substr(0, marker));
    pattern = pattern.substr(marker + 3);
  }
  const auto slash = pattern.find('/');
  if (slash != std::string::npos) {
    rule.cidr = true;
    rule.address = pattern.substr(0, slash);
    rule.prefix = std::atoi(pattern.substr(slash + 1).c_str());
    return rule;
  }
  const auto colon = pattern.rfind(':');
  if (colon != std::string::npos && pattern.find(']') == std::string::npos &&
      pattern.find(':') == colon) {
    rule.port = std::atoi(pattern.substr(colon + 1).c_str());
    pattern = pattern.substr(0, colon);
  }
  pattern = lower(pattern);
  if (!pattern.empty() && pattern.front() == '.') {
    pattern = "*" + pattern;
  }
  rule.host = pattern;
  return rule;
}

bool globMatch(const std::string& pattern, const std::string& text) {
  size_t p = 0, t = 0, star = std::string::npos, mark = 0;
  while (t < text.size()) {
    if (p < pattern.size() && (pattern[p] == text[t])) {
      ++p;
      ++t;
    } else if (p < pattern.size() && pattern[p] == '*') {
      star = p++;
      mark = t;
    } else if (star != std::string::npos) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.size() && pattern[p] == '*') {
    ++p;
  }
  return p == pattern.size();
}

bool ipv4(const std::string& text, uint32_t& out) {
  unsigned a, b, c, d;
  char extra;
  if (std::sscanf(text.c_str(), "%u.%u.%u.%u%c", &a, &b, &c, &d, &extra) != 4 ||
      a > 255 || b > 255 || c > 255 || d > 255) {
    return false;
  }
  out = (a << 24) | (b << 16) | (c << 8) | d;
  return true;
}

struct Target {
  std::string scheme;
  std::string host;
  int port{0};
};

std::optional<Target> parseTarget(const std::string& url) {
  const auto marker = url.find("://");
  if (marker == std::string::npos) {
    return std::nullopt;
  }
  Target target;
  target.scheme = lower(url.substr(0, marker));
  auto rest = url.substr(marker + 3);
  rest = rest.substr(0, rest.find_first_of("/?#"));
  const auto at = rest.rfind('@');
  if (at != std::string::npos) {
    rest = rest.substr(at + 1);
  }
  if (!rest.empty() && rest.front() == '[') {
    const auto close = rest.find(']');
    target.host = lower(rest.substr(1, close - 1));
    if (close + 1 < rest.size() && rest[close + 1] == ':') {
      target.port = std::atoi(rest.substr(close + 2).c_str());
    }
  } else {
    const auto colon = rest.find(':');
    target.host = lower(rest.substr(0, colon));
    if (colon != std::string::npos) {
      target.port = std::atoi(rest.substr(colon + 1).c_str());
    }
  }
  if (target.port == 0) {
    target.port = target.scheme == "https" || target.scheme == "wss" ? 443 : 80;
  }
  return target;
}

bool isBypassed(const BypassRule& rule, const Target& target) {
  if (rule.simpleHostnames) {
    uint32_t ignored;
    return target.host.find('.') == std::string::npos &&
        target.host.find(':') == std::string::npos &&
        !ipv4(target.host, ignored);
  }
  if (!rule.scheme.empty() && rule.scheme != target.scheme) {
    return false;
  }
  if (rule.cidr) {
    uint32_t network, address;
    if (!ipv4(rule.address, network) || !ipv4(target.host, address)) {
      return false;
    }
    const uint32_t mask = rule.prefix <= 0
        ? 0
        : (rule.prefix >= 32 ? 0xFFFFFFFFu : ~((1u << (32 - rule.prefix)) - 1));
    return (network & mask) == (address & mask);
  }
  if (rule.port != 0 && rule.port != target.port) {
    return false;
  }
  return globMatch(rule.host, target.host);
}

bool isLoopback(const Target& target) {
  uint32_t address;
  return target.host == "localhost" || target.host == "::1" ||
      (target.host.size() > 10 &&
       target.host.compare(target.host.size() - 10, 10, ".localhost") == 0) ||
      (ipv4(target.host, address) && (address >> 24) == 127);
}

// Parses Chromium proxy rules, or a single proxy URL.
std::string parseRules(const std::string& text, Rules& rules) {
  for (const auto& piece : split(text, ";")) {
    const auto entry = trim(piece);
    if (entry.empty()) {
      continue;
    }
    std::string key = "*";
    std::string list = entry;
    const auto equals = entry.find('=');
    const auto marker = entry.find("://");
    if (equals != std::string::npos &&
        (marker == std::string::npos || equals < marker)) {
      key = lower(trim(entry.substr(0, equals)));
      list = entry.substr(equals + 1);
      if (key != "http" && key != "https" && key != "ftp" && key != "socks") {
        return "unknown scheme \"" + key + "\" in the proxy rules";
      }
    }
    std::optional<Endpoint> chosen;
    for (const auto& candidate : split(list, ",")) {
      if (trim(candidate).empty()) {
        continue;
      }
      chosen = parseProxyUri(candidate);
      if (!chosen) {
        return "invalid proxy \"" + trim(candidate) + "\"";
      }
      break;
    }
    if (!chosen) {
      return "no proxy in \"" + entry + "\"";
    }
    if (key == "socks" && !chosen->direct) {
      // `socks=host:port` means SOCKS, not an HTTP proxy.
      const auto bare = trim(list);
      if (bare.find("://") == std::string::npos) {
        chosen = parseProxyUri("socks4://" + bare);
      }
    }
    rules.bySchemeKey[key] = *chosen;
  }
  return "";
}

void parseBypassList(const std::string& text, Rules& rules) {
  for (const auto& pattern : split(text, ",;")) {
    if (auto rule = parseBypass(pattern)) {
      rules.bypass.push_back(*rule);
    }
  }
}

#if defined(__APPLE__)
std::string stringValue(CFDictionaryRef dictionary, CFStringRef key) {
  const auto value =
      static_cast<CFStringRef>(CFDictionaryGetValue(dictionary, key));
  if (value == nullptr || CFGetTypeID(value) != CFStringGetTypeID()) {
    return "";
  }
  char buffer[512];
  return CFStringGetCString(
             value, buffer, sizeof(buffer), kCFStringEncodingUTF8)
      ? buffer
      : "";
}

bool flag(CFDictionaryRef dictionary, CFStringRef key) {
  const auto value =
      static_cast<CFNumberRef>(CFDictionaryGetValue(dictionary, key));
  int number = 0;
  return value != nullptr && CFGetTypeID(value) == CFNumberGetTypeID() &&
      CFNumberGetValue(value, kCFNumberIntType, &number) && number != 0;
}

int number(CFDictionaryRef dictionary, CFStringRef key) {
  const auto value =
      static_cast<CFNumberRef>(CFDictionaryGetValue(dictionary, key));
  int result = 0;
  if (value != nullptr && CFGetTypeID(value) == CFNumberGetTypeID()) {
    CFNumberGetValue(value, kCFNumberIntType, &result);
  }
  return result;
}

// The system's proxies, read at most every few seconds.
Rules systemRules() {
  static std::mutex mutex;
  static Rules cached;
  static std::chrono::steady_clock::time_point readAt;
  static bool haveCache = false;
  std::lock_guard<std::mutex> lock(mutex);
  const auto now = std::chrono::steady_clock::now();
  if (haveCache && now - readAt < std::chrono::seconds(5)) {
    return cached;
  }
  Rules rules;
  if (const auto settings = SCDynamicStoreCopyProxies(nullptr)) {
    const struct {
      const char* key;
      CFStringRef enable;
      CFStringRef host;
      CFStringRef port;
      const char* scheme;
    } kinds[] = {
        {"http",
         CFSTR("HTTPEnable"),
         CFSTR("HTTPProxy"),
         CFSTR("HTTPPort"),
         "http"},
        {"https",
         CFSTR("HTTPSEnable"),
         CFSTR("HTTPSProxy"),
         CFSTR("HTTPSPort"),
         "http"},
        {"socks",
         CFSTR("SOCKSEnable"),
         CFSTR("SOCKSProxy"),
         CFSTR("SOCKSPort"),
         "socks5"},
    };
    for (const auto& kind : kinds) {
      if (!flag(settings, kind.enable)) {
        continue;
      }
      const auto host = stringValue(settings, kind.host);
      const auto port = number(settings, kind.port);
      if (host.empty()) {
        continue;
      }
      if (auto endpoint = parseProxyUri(
              std::string(kind.scheme) + "://" + host +
              (port != 0 ? ":" + std::to_string(port) : ""))) {
        rules.bySchemeKey[kind.key] = *endpoint;
      }
    }
    if (flag(settings, CFSTR("ExcludeSimpleHostnames"))) {
      parseBypassList("<local>", rules);
    }
    if (const auto exceptions = static_cast<CFArrayRef>(
            CFDictionaryGetValue(settings, CFSTR("ExceptionsList")))) {
      for (CFIndex i = 0; i < CFArrayGetCount(exceptions); ++i) {
        const auto item =
            static_cast<CFStringRef>(CFArrayGetValueAtIndex(exceptions, i));
        char buffer[512];
        if (CFStringGetCString(
                item, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
          parseBypassList(buffer, rules);
        }
      }
    }
    CFRelease(settings);
  }
  cached = rules;
  readAt = now;
  haveCache = true;
  return rules;
}
#endif

// The proxy for `url` under `rules`, or nullopt for none.
std::optional<std::string> proxyFor(
    const Rules& rules,
    const std::string& url) {
  const auto target = parseTarget(url);
  if (!target) {
    return std::nullopt;
  }
  if (isLoopback(*target)) {
    return std::nullopt;
  }
  for (const auto& rule : rules.bypass) {
    if (isBypassed(rule, *target)) {
      return std::nullopt;
    }
  }
  const std::string scheme = target->scheme == "wss" ? "https"
      : target->scheme == "ws"                       ? "http"
                                                     : target->scheme;
  for (const auto& key : {scheme, std::string("*"), std::string("socks")}) {
    const auto found = rules.bySchemeKey.find(key);
    if (found != rules.bySchemeKey.end()) {
      if (found->second.direct) {
        return std::nullopt;
      }
      return found->second.url;
    }
  }
  return std::nullopt;
}

std::optional<std::string> resolveProxy(const std::string& url) {
  Config snapshot;
  {
    std::lock_guard<std::mutex> lock(configMutex);
    snapshot = config;
  }
  switch (snapshot.mode) {
    case Mode::Direct:
      return std::nullopt;
    case Mode::Fixed:
      return proxyFor(snapshot.fixed, url);
    case Mode::System:
#if defined(__APPLE__)
      return proxyFor(systemRules(), url);
#else
      // Elsewhere libcurl reads HTTP_PROXY, HTTPS_PROXY and NO_PROXY itself.
      return std::nullopt;
#endif
  }
  return std::nullopt;
}

// Whether libcurl's own reading of HTTP_PROXY, HTTPS_PROXY and NO_PROXY stands.
bool environmentProxy(const Config& snapshot) {
  return snapshot.mode == Mode::System;
}

} // namespace

rust::String rn_gpui_network_configure(
    rust::Str mode,
    rust::Str rules,
    rust::Str bypass,
    rust::Str doh) {
  Config next;
  const std::string modeText(mode);
  if (modeText == "system") {
    next.mode = Mode::System;
  } else if (modeText == "direct") {
    next.mode = Mode::Direct;
  } else if (modeText == "fixed") {
    next.mode = Mode::Fixed;
    const auto error = parseRules(std::string(rules), next.fixed);
    if (!error.empty()) {
      return error;
    }
    parseBypassList(std::string(bypass), next.fixed);
  } else {
    return "unknown proxy mode \"" + modeText + "\"";
  }
  next.doh = split(std::string(doh), "\n");
  std::lock_guard<std::mutex> lock(configMutex);
  config = std::move(next);
  return "";
}

rust::String rn_gpui_network_proxy_for(rust::Str url) {
  const auto proxy = resolveProxy(std::string(url));
  return proxy ? *proxy : "DIRECT";
}

void applyNetworkConfig(CURL* handle, const std::string& url) {
  Config snapshot;
  {
    std::lock_guard<std::mutex> lock(configMutex);
    snapshot = config;
  }
  const auto proxy = resolveProxy(url);
  if (proxy) {
    curl_easy_setopt(handle, CURLOPT_PROXY, proxy->c_str());
  } else if (!environmentProxy(snapshot)) {
    // An empty string turns proxies off, including the environment's.
    curl_easy_setopt(handle, CURLOPT_PROXY, "");
  }
  if (!snapshot.doh.empty()) {
    curl_easy_setopt(handle, CURLOPT_DOH_URL, snapshot.doh.front().c_str());
  }
}

bool fallBackResolver(CURL* handle, size_t& attempt) {
  std::vector<std::string> servers;
  {
    std::lock_guard<std::mutex> lock(configMutex);
    servers = config.doh;
  }
  if (servers.empty() || attempt >= servers.size()) {
    return false;
  }
  attempt += 1;
  if (attempt < servers.size()) {
    curl_easy_setopt(handle, CURLOPT_DOH_URL, servers[attempt].c_str());
  } else {
    // Every server failed: the system resolver is the last resort.
    curl_easy_setopt(handle, CURLOPT_DOH_URL, nullptr);
  }
  return true;
}

} // namespace rngpui
