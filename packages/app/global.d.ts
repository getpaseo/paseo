declare module "*.css";

/** Vite's `?raw` import, used by tests that assert on a shipped file's contents. */
declare module "*?raw" {
  const content: string;
  export default content;
}
