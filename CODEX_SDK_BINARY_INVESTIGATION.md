# Codex SDK Binary Investigation Report

**Date:** 2025-12-20
**SDK Version:** @openai/codex-sdk@0.76.0
**Status:** ✅ System binary usage is fully supported

---

## Executive Summary

The `@openai/codex-sdk` library **DOES support using a system-installed Codex binary** instead of the embedded one. This is accomplished via the `codexPathOverride` configuration option in the `CodexOptions` interface.

---

## How the SDK Currently Locates the Codex Binary

### Default Behavior (Embedded Binary)

When no override is provided, the SDK uses the `findCodexPath()` function to locate the embedded binary:

**Source:** `dist/index.js:278-330`

```typescript
function findCodexPath() {
  const { platform, arch } = process;
  let targetTriple = null;

  // Determines platform-specific binary path
  // e.g., "aarch64-apple-darwin" for Apple Silicon Macs

  const vendorRoot = path2.join(scriptDirName, "..", "vendor");
  const archRoot = path2.join(vendorRoot, targetTriple);
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const binaryPath = path2.join(archRoot, "codex", codexBinaryName);
  return binaryPath;
}
```

### Binary Location Structure

The SDK ships with pre-compiled binaries in the `vendor/` directory:

```
node_modules/@openai/codex-sdk/
├── vendor/
│   ├── aarch64-apple-darwin/codex/codex       (40MB - Apple Silicon)
│   ├── x86_64-apple-darwin/codex/codex        (Intel Mac)
│   ├── aarch64-unknown-linux-musl/codex/codex (ARM Linux)
│   ├── x86_64-unknown-linux-musl/codex/codex  (x86_64 Linux)
│   ├── aarch64-pc-windows-msvc/codex/codex.exe (ARM Windows)
│   └── x86_64-pc-windows-msvc/codex/codex.exe (x86_64 Windows)
```

---

## Configuration Options Available

### `codexPathOverride` Option

**Type Definition:** `dist/index.d.ts:209-218`

```typescript
type CodexOptions = {
    codexPathOverride?: string;  // ← THIS IS THE KEY OPTION
    baseUrl?: string;
    apiKey?: string;
    env?: Record<string, string>;
};
```

**Implementation:** `dist/index.js:336-338`

```typescript
constructor(options = {}) {
  this.exec = new CodexExec(options.codexPathOverride, options.env);
  this.options = options;
}
```

**How it works:** `dist/index.js:145-147`

```typescript
constructor(executablePath = null, env) {
  this.executablePath = executablePath || findCodexPath();
  this.envOverride = env;
}
```

The `codexPathOverride` is passed as `executablePath`. If provided, it bypasses the `findCodexPath()` function entirely.

---

## How to Use a System Codex Binary

### Method 1: Direct Path Specification

```typescript
import { Codex } from '@openai/codex-sdk';

const codex = new Codex({
  codexPathOverride: '/Users/moboudra/.asdf/installs/nodejs/22.20.0/bin/codex'
});
```

### Method 2: Dynamic PATH Resolution

```typescript
import { Codex } from '@openai/codex-sdk';
import { execSync } from 'child_process';

const systemCodexPath = execSync('which codex', { encoding: 'utf8' }).trim();

const codex = new Codex({
  codexPathOverride: systemCodexPath
});
```

### Method 3: Environment Variable Based (Custom Implementation)

```typescript
import { Codex } from '@openai/codex-sdk';

const codex = new Codex({
  codexPathOverride: process.env.CODEX_BINARY_PATH || undefined
});
```

**Note:** The SDK does NOT have a built-in environment variable for this purpose. The `CODEX_BINARY_PATH` above is a custom convention you'd need to implement in your application.

---

## Verification Test Results

### Test Configuration

- **System Codex:** `/Users/moboudra/.asdf/installs/nodejs/22.20.0/bin/codex`
- **Embedded Codex:** `node_modules/@openai/codex-sdk/vendor/aarch64-apple-darwin/codex/codex`
- **Versions:** Both are `codex-cli 0.76.0`

### Test Results

```bash
$ node test-codex-path-override.mjs
Testing codexPathOverride option...

Test 1: Using default embedded binary
✓ Created Codex instance with default settings

Test 2: Using system binary via codexPathOverride
✓ Created Codex instance with codexPathOverride

Test 3: Using which codex result
System codex location: /Users/moboudra/.asdf/installs/nodejs/22.20.0/bin/codex
✓ Created Codex instance with system codex from PATH

✅ All tests passed!
```

---

## Benefits of Using System Codex

### 1. **Version Control**
- Update codex independently via package manager (npm, brew, asdf, etc.)
- No need to wait for SDK release to get latest codex features
- Easier to test beta/development versions

### 2. **Disk Space Savings**
- Embedded binary: ~40MB per architecture
- In a monorepo with multiple node_modules: Saves 40MB × number of installations
- System binary: Single installation regardless of projects

### 3. **Consistency**
- Same codex version across all tools and SDKs
- Easier debugging when CLI and SDK use identical binaries
- Simplified version management

### 4. **Development Workflow**
- Test local codex builds without reinstalling SDK
- Point to custom-compiled binaries for debugging
- A/B test different codex versions easily

---

## Potential Considerations

### 1. **Version Compatibility**
- SDK expects specific codex CLI behavior
- Using mismatched versions might cause issues
- SDK is at v0.76.0, ensure system codex matches or is compatible

### 2. **PATH Availability**
- System binary must be accessible when Node.js process runs
- Consider environment differences (development vs production)
- Absolute paths are safer than relying on PATH resolution

### 3. **No Fallback**
- If codexPathOverride points to invalid/missing binary, execution will fail
- SDK doesn't automatically fall back to embedded binary
- Implement error handling if using dynamic resolution

---

## Environment Variables (Built-in)

The SDK does NOT provide a built-in environment variable for binary path override, but it does use these:

### Used by SDK

1. **`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`** (Internal)
   - Source: `dist/index.js:140-141`
   - Set to `"codex_sdk_ts"` to identify SDK usage
   - Not for user configuration

2. **`OPENAI_BASE_URL`** (Configurable)
   - Override via `CodexOptions.baseUrl`
   - Also injectable via env

3. **`CODEX_API_KEY`** (Configurable)
   - Override via `CodexOptions.apiKey`
   - Also injectable via env

### NOT Provided

- ❌ `CODEX_BINARY_PATH` - Not a built-in feature
- ❌ `CODEX_PATH` - Not a built-in feature
- ❌ Auto-discovery via system PATH - Not implemented

---

## Recommended Implementation Pattern

For maximum flexibility, consider this pattern:

```typescript
import { Codex } from '@openai/codex-sdk';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

function createCodexInstance(options = {}) {
  // Priority order:
  // 1. Explicit override in options
  // 2. Environment variable
  // 3. System PATH
  // 4. Embedded binary (SDK default)

  let codexPath = options.codexPathOverride;

  if (!codexPath && process.env.CODEX_BINARY_PATH) {
    codexPath = process.env.CODEX_BINARY_PATH;
  }

  if (!codexPath) {
    try {
      codexPath = execSync('which codex', { encoding: 'utf8' }).trim();
      if (!existsSync(codexPath)) {
        codexPath = undefined;
      }
    } catch {
      // Fall back to embedded binary
      codexPath = undefined;
    }
  }

  return new Codex({
    ...options,
    codexPathOverride: codexPath
  });
}

// Usage
const codex = createCodexInstance();
```

---

## Summary

| Question | Answer |
|----------|--------|
| **Can SDK use system codex?** | ✅ Yes, via `codexPathOverride` |
| **Is configuration option available?** | ✅ Yes, in `CodexOptions` interface |
| **Built-in env variable support?** | ❌ No, must implement custom logic |
| **Automatic PATH resolution?** | ❌ No, must provide explicit path |
| **Fallback to embedded?** | ❌ No, fails if override is invalid |
| **Version tested** | 0.76.0 (both system and embedded) |

---

## Conclusion

The `@openai/codex-sdk` library provides full support for using a system-installed Codex binary through the `codexPathOverride` configuration option. This feature is well-designed and allows developers to choose between the convenience of embedded binaries and the flexibility of system-managed installations.

To use a system binary:
1. Install codex globally (via npm, brew, asdf, etc.)
2. Pass the path via `codexPathOverride` when instantiating `Codex`
3. Optionally implement PATH resolution logic for automatic discovery

The embedded binary remains the default, ensuring the SDK works out-of-the-box without requiring system-wide codex installation.
