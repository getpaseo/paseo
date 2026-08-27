export function resolveDevElectronArgs(platform, forwardedArgs) {
  if (platform === "linux") {
    return ["--no-sandbox", ...forwardedArgs];
  }

  return forwardedArgs;
}
