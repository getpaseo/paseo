// OpenCode reloads the plugin entry point independently from this module.
// Keep live bindings and tool definitions in memory across those reloads.
const locations = new Map();

export function stateFor(location) {
  const key = JSON.stringify([location.directory, location.workspaceID ?? null]);
  if (!locations.has(key)) {
    locations.set(key, { bindings: new Map(), definitions: new Map() });
  }
  return locations.get(key);
}
