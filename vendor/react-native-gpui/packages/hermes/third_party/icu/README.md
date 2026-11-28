# ICU C headers

The 39 headers of ICU 76.1 (`icu4c`, unmodified) that the Hermes Intl backend
and its ICU loader compile against. Nothing from ICU is linked or shipped:
the engine finds the system's ICU at run time (`icu.dll` on Windows,
`libicui18n.so.N` on Linux, `libicucore` on macOS). The headers only give the
function signatures and types, so the backend calls only functions that exist
in ICU 64, the minimum.

Passed to the Hermes configure step as `-DHERMES_ICU_HEADERS_DIR=<this folder>`.
`LICENSE` is ICU's own.
