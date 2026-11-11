// `which` ships no types. Imported statically (not through createRequire) so the terminal
// worker bundle includes it: the worker runs from a copy that has only node-pty beside it.
// Listed in the tsconfig includes, since nothing imports a declaration file.
declare module "which" {
  function which(
    command: string,
    options: { all: true; path?: string; pathExt?: string },
  ): Promise<string[]>;
  export default which;
}
