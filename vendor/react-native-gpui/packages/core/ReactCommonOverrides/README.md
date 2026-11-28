# ReactCommonOverrides

Copies of React Native sources that react-native-gpui compiles in place of the upstream file, or headers that shadow the upstream ones on the include path. Each one is tracked in `../overrides.json` with the hash of the upstream file it came from, so `react-native-platform-override validate` reports drift when React Native is upgraded. To re-apply a change after an upgrade, diff the new upstream file against the copy and carry the hunks over.

The overrides are hashed into the prebuilt archive (`scripts/prebuilt-inputs.mjs`). Changing one makes a prebuilt built from other overrides stale, and the prebuilt has to be rebuilt.

## Yoga: the `FlexBasisAsIntrinsicSize` errata

Copied from React Native 0.87.1, `packages/react-native/ReactCommon/yoga/yoga`:

| File | Change |
| --- | --- |
| `yoga/enums/Errata.h` | `FlexBasisAsIntrinsicSize = YGErrataFlexBasisAsIntrinsicSize` |
| `yoga/YGEnums.h` | `YGErrataFlexBasisAsIntrinsicSize = 16` in `YGErrata`. `YGErrataAll` and `YGErrataClassic` include it. |
| `yoga/YGEnums.cpp` | `YGErrataToString` returns `flex-basis-as-intrinsic-size` for it. |
| `yoga/algorithm/CalculateLayout.cpp` | In `computeFlexBasisForChild`, after `useResolvedFlexBasis` is computed: when the child does not have the errata, its main sizing mode is not `StretchFit`, `resolveFlexGrow() > 0`, and its basis is a percentage or resolves to 0, `useResolvedFlexBasis` is set to false so the child is measured for content. The computed basis is also recomputed on every call for a child without the errata, so the final layout uses the basis again. |

With the errata set, which is the default (`YGErrataAll`) and what `classic` conformance gives, the code path is the upstream one. It is cleared in a `strict` `LayoutConformance` subtree, where `resolveErrata` returns only `MinSizeUndefinedInsteadOfAuto`.

`yoga/algorithm/CalculateLayout.cpp` and `yoga/YGEnums.cpp` replace the upstream sources of the `yogacore` target in `ReactGpui/rn-gpui-sys/cpp/CMakeLists.txt`. The headers shadow the upstream ones on the include path.

`ReactGpui/rn-gpui-sys/cpp/GpuiMountingManager.cpp` registers `LayoutConformanceComponentDescriptor`, so `experimental_LayoutConformance` creates a node on desktop.

## Loom variants

`../ReactCommonOverrides.loom` holds the replacements of files that Loom also replaces. A Loom build compiles those and puts that directory first on the include path. `NativeDOM.cpp` and `NativeDOM.h` are Loom's files with the same two changes as the copies above (no backticks in `#pragma mark`, the header included through the override include path). Each entry in `../overrides.json` names the Loom file it came from and its hash (`loomBaseHash`); see `../ReactGpui/LOOM_PIN.md`.
