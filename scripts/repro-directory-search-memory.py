"""Create the real directory tree for the opt-in directory-search memory regression test.

Run from the checkout root, then run:
PASEO_REPRO_SEARCH_ROOT="$PWD/.diagnose-4879/home" npm exec --workspace=@getpaseo/server -- vitest run src/utils/directory-suggestions-memory.local.e2e.test.ts
The fixture needs approximately 6 GB of disk space. No heap limit or delay is injected.
"""
import os
import time

root = os.path.join(os.getcwd(), ".diagnose-4879", "home")
os.makedirs(root, exist_ok=True)
start = time.monotonic()
for branch_index in range(100):
    branch = os.path.join(root, f"repos-{branch_index:03}")
    os.makedirs(branch, exist_ok=True)
    for package_index in range(140):
        package = os.path.join(branch, f"packages-{package_index:03}")
        os.makedirs(package, exist_ok=True)
        for component_index in range(100):
            os.makedirs(os.path.join(package, f"component-{component_index:03}"), exist_ok=True)
    if branch_index % 10 == 9:
        print(f"{branch_index + 1} branches built in {time.monotonic() - start:.1f}s", flush=True)
for name in ["ai-credential-refresh", "ai-engineer-reference", "ai-tevv", "gmail-local-sync"]:
    os.makedirs(os.path.join(root, "workspace", "projects", name), exist_ok=True)
print("Created 1,414,106 directories", flush=True)
