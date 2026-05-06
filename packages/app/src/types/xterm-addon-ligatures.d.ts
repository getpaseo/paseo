declare module "@xterm/addon-ligatures/lib/addon-ligatures.mjs" {
  export class LigaturesAddon {
    constructor();
    activate(terminal: unknown): void;
    dispose(): void;
  }
}
