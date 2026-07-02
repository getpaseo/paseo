const ENV_REFERENCE_PATTERN = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
const ENV_REFERENCE_DETECT = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/;

export function findEnvReferences(value: string): string[] {
  return Array.from(value.matchAll(ENV_REFERENCE_PATTERN), (match) => match[1]);
}

export function hasEnvReference(value: string): boolean {
  return ENV_REFERENCE_DETECT.test(value);
}

export function substituteEnvReferences(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const result = value.replace(ENV_REFERENCE_PATTERN, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      missing = true;
      return "";
    }
    return resolved;
  });
  return missing ? undefined : result;
}
