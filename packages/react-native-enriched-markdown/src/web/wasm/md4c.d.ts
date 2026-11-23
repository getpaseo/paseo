// Type declarations for the Emscripten-generated md4c WASM module.
// The actual md4c.js file is produced by cpp/wasm/build.sh and committed to git.

interface Md4cModule {
  cwrap(
    name: string,
    returnType: string,
    argTypes: string[]
  ): (...args: unknown[]) => unknown;
  ccall(
    name: string,
    returnType: string,
    argTypes: string[],
    args: unknown[]
  ): unknown;
  UTF8ToString(ptr: number): string;
}

declare function createMd4cModule(options?: object): Promise<Md4cModule>;

export default createMd4cModule;
