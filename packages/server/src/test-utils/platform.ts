export function isPlatform(...platforms: NodeJS.Platform[]): boolean {
  return platforms.includes(process.platform);
}
