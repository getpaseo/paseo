import { createTerminal, type TerminalSession } from "./terminal.js";

export interface TerminalManager {
  getTerminals(cwd: string): Promise<TerminalSession[]>;
  createTerminal(options: { cwd: string; name?: string }): Promise<TerminalSession>;
  getTerminal(id: string): TerminalSession | undefined;
  killTerminal(id: string): void;
  listDirectories(): string[];
  killAll(): void;
}

export function createTerminalManager(): TerminalManager {
  const terminalsByCwd = new Map<string, TerminalSession[]>();
  const terminalsById = new Map<string, TerminalSession>();

  function assertAbsolutePath(cwd: string): void {
    if (!cwd.startsWith("/")) {
      throw new Error("cwd must be absolute path");
    }
  }

  return {
    async getTerminals(cwd: string): Promise<TerminalSession[]> {
      assertAbsolutePath(cwd);

      let terminals = terminalsByCwd.get(cwd);
      if (!terminals || terminals.length === 0) {
        const session = await createTerminal({ cwd, name: "Terminal 1" });
        terminals = [session];
        terminalsByCwd.set(cwd, terminals);
        terminalsById.set(session.id, session);
      }
      return terminals;
    },

    async createTerminal(options: { cwd: string; name?: string }): Promise<TerminalSession> {
      assertAbsolutePath(options.cwd);

      const terminals = terminalsByCwd.get(options.cwd) ?? [];
      const defaultName = `Terminal ${terminals.length + 1}`;
      const session = await createTerminal({
        cwd: options.cwd,
        name: options.name ?? defaultName,
      });

      terminals.push(session);
      terminalsByCwd.set(options.cwd, terminals);
      terminalsById.set(session.id, session);

      return session;
    },

    getTerminal(id: string): TerminalSession | undefined {
      return terminalsById.get(id);
    },

    killTerminal(id: string): void {
      const session = terminalsById.get(id);
      if (!session) return;

      session.kill();
      terminalsById.delete(id);

      const terminals = terminalsByCwd.get(session.cwd);
      if (terminals) {
        const index = terminals.indexOf(session);
        if (index !== -1) {
          terminals.splice(index, 1);
        }
        if (terminals.length === 0) {
          terminalsByCwd.delete(session.cwd);
        }
      }
    },

    listDirectories(): string[] {
      return Array.from(terminalsByCwd.keys());
    },

    killAll(): void {
      for (const session of terminalsById.values()) {
        session.kill();
      }
      terminalsByCwd.clear();
      terminalsById.clear();
    },
  };
}
