/**
 * First-run setup: a one-time modal that walks a new user through the surfaces Settings
 * already has — appearance, providers, projects, Paseo tools and phone pairing.
 *
 * The app shell mounts the host; Settings reopens it. Whether it opens, which steps it has,
 * and how completion is remembered stay inside; import from `@/onboarding` only.
 */
export { OnboardingHost } from "./onboarding-host";
export { useOpenOnboarding } from "./use-open-onboarding";
