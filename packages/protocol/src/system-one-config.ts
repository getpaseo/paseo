export const DEFAULT_TYPESAFE_API_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export function isSafeSystemOneEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}
