#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include <rust/cxx.h>

namespace rngpui {

/// A value crosses the cxx bridge as nodes in a C++-owned arena, one scope per
/// call, so nothing is serialised to text and ownership stays on one side. The
/// side that opens a scope closes it.
enum DynamicKind : uint8_t {
  DynamicNull = 0,
  DynamicBool = 1,
  DynamicNumber = 2,
  DynamicString = 3,
  DynamicArray = 4,
  DynamicObject = 5,
  DynamicBuffer = 6,
};

constexpr uint32_t kDynamicNoNode = 0xffffffffu;

uint32_t dynamic_scope_open();
void dynamic_scope_close(uint32_t scope);

/// `key` names an object member; an array child has none.
uint32_t dynamic_node_new(uint32_t scope, uint8_t kind);
void dynamic_node_set_bool(uint32_t scope, uint32_t node, bool value);
void dynamic_node_set_number(uint32_t scope, uint32_t node, double value);
void dynamic_node_set_text(uint32_t scope, uint32_t node, rust::Str text);
void dynamic_node_set_buffer(
    uint32_t scope,
    uint32_t node,
    rust::Slice<const uint8_t> bytes);
void dynamic_node_append(
    uint32_t scope,
    uint32_t parent,
    uint32_t child,
    rust::Str key);

uint8_t dynamic_node_kind(uint32_t scope, uint32_t node);
bool dynamic_node_bool(uint32_t scope, uint32_t node);
double dynamic_node_number(uint32_t scope, uint32_t node);
rust::String dynamic_node_text(uint32_t scope, uint32_t node);
size_t dynamic_node_len(uint32_t scope, uint32_t node);
size_t dynamic_node_buffer_len(uint32_t scope, uint32_t node);
rust::Vec<uint8_t> dynamic_node_buffer(uint32_t scope, uint32_t node);
uint32_t dynamic_node_child(uint32_t scope, uint32_t node, size_t index);
rust::String dynamic_node_key(uint32_t scope, uint32_t node, size_t index);

} // namespace rngpui
