const { execFileSync } = require("node:child_process");

function hasConfiguredSigningIdentity(env) {
  return ["CSC_LINK", "CSC_NAME", "CSC_IDENTITY"].some((name) => (env[name] ?? "").trim() !== "");
}

function hasKeychainIdentity(env, options = {}) {
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return false;
  if ((options.platform ?? process.platform) !== "darwin") return false;

  const run = options.run ?? execFileSync;
  try {
    const output = run("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /\b[1-9]\d* valid identities found\b/.test(output);
  } catch {
    return false;
  }
}

function isMacSigningAvailable(env, options) {
  return hasConfiguredSigningIdentity(env) || hasKeychainIdentity(env, options);
}

module.exports = {
  hasKeychainIdentity,
  isMacSigningAvailable,
};
