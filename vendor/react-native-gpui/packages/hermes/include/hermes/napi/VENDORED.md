# Vendored Node-API headers

These files are vendored byte-for-byte from the Node.js project:

| File                      | Upstream path             |
|---------------------------|---------------------------|
| `js_native_api.h`         | `src/js_native_api.h`     |
| `js_native_api_types.h`   | `src/js_native_api_types.h` |
| `node_api.h`              | `src/node_api.h`          |
| `node_api_types.h`        | `src/node_api_types.h`    |

- Upstream: https://github.com/nodejs/node
- Version:  v24.13.0 (commit `def0bdf8`)

Do not modify these files. To opt into a specific Node-API version,
define `NAPI_VERSION` on the consumer's compile command line — the
Hermes implementation sets `NAPI_VERSION=10` for its own library and
unit tests (see `API/napi/CMakeLists.txt` and `unittests/napi/CMakeLists.txt`).

To refresh against a newer upstream, replace the files in this
directory with the same files from the target Node.js release and
update the version table above.
