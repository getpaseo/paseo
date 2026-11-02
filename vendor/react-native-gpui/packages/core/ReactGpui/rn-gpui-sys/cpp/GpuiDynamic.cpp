#include "GpuiDynamic.h"

#include <atomic>
#include <mutex>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace rngpui {

namespace {

/// One node of a value: scalars, or children with the key that names them in an
/// object.
struct Node {
  uint8_t kind = DynamicNull;
  // Holds a number, or a bool as 0 or 1.
  double number = 0.0;
  std::string text;
  std::vector<uint8_t> bytes;
  std::vector<std::pair<std::string, uint32_t>> children;
};

struct Scope {
  std::vector<Node> nodes;
};

std::mutex& scopesMutex() {
  static std::mutex mutex;
  return mutex;
}

std::unordered_map<uint32_t, Scope>& scopes() {
  static std::unordered_map<uint32_t, Scope> map;
  return map;
}

std::atomic<uint32_t>& nextScopeId() {
  static std::atomic<uint32_t> next{1};
  return next;
}

Node& nodeAt(uint32_t scope, uint32_t node) {
  std::lock_guard<std::mutex> lock(scopesMutex());
  auto found = scopes().find(scope);
  if (found == scopes().end()) {
    throw std::runtime_error("dynamic scope is gone");
  }
  if (node >= found->second.nodes.size()) {
    throw std::runtime_error("dynamic node is gone");
  }
  return found->second.nodes[node];
}

void checkKind(const Node& node, uint8_t kind, const char* what) {
  if (node.kind != kind) {
    throw std::runtime_error(std::string("expected ") + what);
  }
}

/// Adds an empty node and returns its id. Callers must not hold a reference to
/// another node across this, since the vector may move.
uint32_t appendNode(Scope& scope) {
  scope.nodes.emplace_back();
  return static_cast<uint32_t>(scope.nodes.size() - 1);
}

} // namespace

uint32_t dynamic_scope_open() {
  const uint32_t id = nextScopeId().fetch_add(1);
  std::lock_guard<std::mutex> lock(scopesMutex());
  scopes().emplace(id, Scope{});
  return id;
}

void dynamic_scope_close(uint32_t scope) {
  std::lock_guard<std::mutex> lock(scopesMutex());
  scopes().erase(scope);
}

uint32_t dynamic_node_new(uint32_t scope, uint8_t kind) {
  std::lock_guard<std::mutex> lock(scopesMutex());
  auto found = scopes().find(scope);
  if (found == scopes().end()) {
    throw std::runtime_error("dynamic scope is gone");
  }
  found->second.nodes.emplace_back();
  Node& node = found->second.nodes.back();
  node.kind = kind;
  return static_cast<uint32_t>(found->second.nodes.size() - 1);
}

void dynamic_node_set_bool(uint32_t scope, uint32_t node, bool value) {
  Node& target = nodeAt(scope, node);
  checkKind(target, DynamicBool, "a boolean");
  target.number = value ? 1.0 : 0.0;
}

void dynamic_node_set_number(uint32_t scope, uint32_t node, double value) {
  Node& target = nodeAt(scope, node);
  checkKind(target, DynamicNumber, "a number");
  target.number = value;
}

void dynamic_node_set_buffer(
    uint32_t scope,
    uint32_t node,
    rust::Slice<const uint8_t> bytes) {
  Node& target = nodeAt(scope, node);
  checkKind(target, DynamicBuffer, "an ArrayBuffer");
  target.bytes.assign(bytes.begin(), bytes.end());
}

void dynamic_node_set_text(uint32_t scope, uint32_t node, rust::Str text) {
  Node& target = nodeAt(scope, node);
  checkKind(target, DynamicString, "a string");
  target.text = std::string(text);
}

void dynamic_node_append(
    uint32_t scope,
    uint32_t parent,
    uint32_t child,
    rust::Str key) {
  Node& target = nodeAt(scope, parent);
  if (target.kind != DynamicArray && target.kind != DynamicObject) {
    throw std::runtime_error("expected an array or an object");
  }
  target.children.emplace_back(std::string(key), child);
}

uint8_t dynamic_node_kind(uint32_t scope, uint32_t node) {
  return nodeAt(scope, node).kind;
}

bool dynamic_node_bool(uint32_t scope, uint32_t node) {
  const Node& target = nodeAt(scope, node);
  checkKind(target, DynamicBool, "a boolean");
  return target.number != 0.0;
}

double dynamic_node_number(uint32_t scope, uint32_t node) {
  const Node& target = nodeAt(scope, node);
  checkKind(target, DynamicNumber, "a number");
  return target.number;
}

rust::String dynamic_node_text(uint32_t scope, uint32_t node) {
  const Node& target = nodeAt(scope, node);
  checkKind(target, DynamicString, "a string");
  return rust::String(target.text);
}

size_t dynamic_node_buffer_len(uint32_t scope, uint32_t node) {
  const Node& target = nodeAt(scope, node);
  checkKind(target, DynamicBuffer, "an ArrayBuffer");
  return target.bytes.size();
}

rust::Vec<uint8_t> dynamic_node_buffer(uint32_t scope, uint32_t node) {
  const Node& target = nodeAt(scope, node);
  checkKind(target, DynamicBuffer, "an ArrayBuffer");
  rust::Vec<uint8_t> bytes;
  bytes.reserve(target.bytes.size());
  for (const uint8_t byte : target.bytes) {
    bytes.push_back(byte);
  }
  return bytes;
}

size_t dynamic_node_len(uint32_t scope, uint32_t node) {
  const Node& target = nodeAt(scope, node);
  if (target.kind != DynamicArray && target.kind != DynamicObject) {
    throw std::runtime_error("expected an array or an object");
  }
  return target.children.size();
}

uint32_t dynamic_node_child(uint32_t scope, uint32_t node, size_t index) {
  const Node& target = nodeAt(scope, node);
  if (index >= target.children.size()) {
    throw std::runtime_error("child index out of range");
  }
  return target.children[index].second;
}

rust::String dynamic_node_key(uint32_t scope, uint32_t node, size_t index) {
  const Node& target = nodeAt(scope, node);
  if (index >= target.children.size()) {
    throw std::runtime_error("child index out of range");
  }
  return rust::String(target.children[index].first);
}

} // namespace rngpui
