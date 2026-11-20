import type { AgentRef, ProjectRef, TerminalRef, WorkspaceRef } from "../refs.js";

/** Owned by the app session, shared by every plugin installation. */
export function createEntityRefs() {
  function intern<Kind extends string>(kind: Kind) {
    const references = new Map<
      string,
      Readonly<{ kind: Kind; key: string; hostId: string; id: string }>
    >();
    return function reference(hostId: string, id: string) {
      const key = JSON.stringify([hostId, id]);
      let ref = references.get(key);
      if (!ref) {
        ref = Object.freeze({ kind, key, hostId, id });
        references.set(key, ref);
      }
      return ref;
    };
  }
  return {
    workspace: intern("workspace") satisfies (hostId: string, id: string) => WorkspaceRef,
    agent: intern("agent") satisfies (hostId: string, id: string) => AgentRef,
    project: intern("project") satisfies (hostId: string, id: string) => ProjectRef,
    terminal: intern("terminal") satisfies (hostId: string, id: string) => TerminalRef,
  };
}
