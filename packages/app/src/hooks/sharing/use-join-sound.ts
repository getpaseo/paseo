// Facade: TypeScript needs an explicit module to resolve `@/hooks/sharing/use-join-sound`.
// Metro replaces this at bundle time with the matching `.web.ts` / `.native.ts` file
// based on the target platform.
export { useJoinSound } from "./use-join-sound.web";
