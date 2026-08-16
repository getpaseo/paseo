# `@getpaseo/workspace-helper`

This is the official workspace filesystem helper for Paseo command runtimes. It owns the
executable, protocol, typed client binding, and confinement rules.

Runtime authors depend on the same release as `@getpaseo/workspace-runtime-contract` and bundle
the `paseo-workspace-helper` bin. Do not implement the helper protocol. The command-runtime
contract and helper protocol have independent version fields; a Paseo release pins compatible
package versions and verifies both describe responses before using a runtime.

The helper receives workspace authority only from its process cwd. All API paths are relative.
Absolute paths, traversal, and symlink escapes are rejected.
