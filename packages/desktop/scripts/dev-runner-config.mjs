export function createElectronSpawnOptions({ env, colorEnv, expoDevUrl }) {
  return {
    // Electron must stay in the runner's process group. Paseo workspace scripts
    // own the terminal process group, so detaching Electron lets it survive a
    // service stop with broken stdout/stderr pipes and block the next launch.
    detached: false,
    env: {
      ...env,
      ...colorEnv,
      EXPO_DEV_URL: expoDevUrl,
    },
  };
}

export function resolveChildKillTarget(pid, detached) {
  return detached ? -pid : pid;
}
