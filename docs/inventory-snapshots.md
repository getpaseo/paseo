# Inventory snapshots

`inventory.sessions.request` is the read-only inventory API for a controller
that must prove it enumerated every Paseo session in one daemon. It is not the
UI directory API and must not be replaced with `fetch_agents_request` or
`paseo ls`.

## Scope

One initial request has the fixed scope `all/global`: every record known to the
daemon's canonical `AgentManager` and `$PASEO_HOME/agents/` registry. This
includes running, initializing, idle, error, closed, archived, internal, and
providers which are unavailable to the normal client directory. Project
placement, active-workspace scope, provider visibility, and persisted-provider
availability do not filter this inventory.

The returned identity is `backend: "paseo"` plus `native_id`, the Paseo daemon
agent UUID. A multi-host controller supplies its configured source/host when it
forms its frozen `(source, backend, native_id)` identity; `native_id` alone is
not cross-daemon identity. `persistence_session_id` is correlation metadata for
the provider session, not a replacement identity.

The daemon refuses the whole inventory if the persistent registry contains a
malformed JSON record, a duplicate agent id, a conflicting live/persisted
provider, or any unreadable path within the registry scope. This includes the
registry root, a project directory, and an individual record file. An absent
registry root (`ENOENT`) means there are no persisted records and is tolerated;
after a directory or record has been observed during a scan, even `ENOENT` is
an explicit issue because it could hide a concurrently removed identity. Those
are explicit `rpc_error`s, never omitted rows. Inventory reads never repair,
delete, or otherwise modify those paths.

## Snapshot and pagination semantics

The API uses materialized snapshot semantics. At the first page the daemon
performs an inventory-only fresh filesystem scan; it never treats the startup
registry cache as proof of completeness. The scan classifies every root and
project entry, validates every persisted record, and performs a second complete
manifest scan. Directory entries, path identity/type/metadata, and record
content hashes must match across both scans. A creation, deletion, replacement,
symlink swap, permission failure, or content change during the scan fails the
request closed. To make the filesystem authority and live `AgentManager`
authority one logical snapshot, the daemon first captures an immutable live
projection plus a monotonic live inventory epoch, then performs the verified
filesystem scan, and finally verifies that the epoch is unchanged. Thus the
live projection was constant at the filesystem scan's materialization point.
Any live or registry drift retries the whole capture at most three times and
then returns `inventory_state_changed`; it never returns a mixed union. The
result is sorted by `(backend, native_id)` using Unicode code-unit ordering,
deep-cloned, and retained for ten minutes.

`snapshot_id` is the SHA-256 digest of its schema version and canonical complete
entry list. Canonical JSON sorts object keys with the same code-unit ordering,
so insertion order and process locale do not change the id. It therefore names
a specific enumerated set, not a request time or an arbitrary UUID.

Every continuation sends both `snapshot_id` and `cursor`. The cursor is
daemon-secret-bound to that snapshot, its absolute next offset, and the owner
`clientId`. It uses strict canonical base64url encoding, so padded or altered
variants are invalid. It cannot be used with another snapshot or client,
changed into a different offset, or loop back to the first page. Both the HMAC
secret and snapshot store belong to the daemon, not a WebSocket `Session`; a
reconnect with the same client id can therefore continue until TTL expiry. A
daemon restart naturally loses the store and never rebuilds an old snapshot.

The daemon keeps at most 64 multi-page snapshots in an access-ordered LRU
cache. A one-page response is not retained. Evicted, foreign-client, and
post-restart cursors return `inventory_snapshot_not_found`; TTL expiry returns
`inventory_snapshot_expired`; malformed, forged, mismatched, and invalid-offset
cursors return `invalid_inventory_cursor`. Snapshot creation is not retried or
silently regenerated on any continuation failure.

Page size is 1–200, ordering is deterministic, and only `has_more: false`
proves the end. Replaying a valid snapshot/cursor pair returns the same page.

Later creation, deletion, lifecycle change, or archiving does not alter an
existing snapshot. It appears in the next snapshot instead. The capability has
no lifecycle, prompt, registry-write, provider, or recovery call path.

## Wire contract

Start an enumeration:

```json
{
  "type": "inventory.sessions.request",
  "requestId": "inventory-1",
  "limit": 200
}
```

Continue it with the returned values:

```json
{
  "type": "inventory.sessions.request",
  "requestId": "inventory-2",
  "snapshot_id": "sha256:…",
  "cursor": "…",
  "limit": 200
}
```

```json
{
  "type": "inventory.sessions.response",
  "payload": {
    "requestId": "inventory-1",
    "schema_version": "paseo.inventory_sessions.v1",
    "snapshot_id": "sha256:…",
    "entries": [
      {
        "backend": "paseo",
        "native_id": "6e77c819-…",
        "provider": "claude",
        "status_raw": "closed",
        "archived": true,
        "archived_at": "2026-08-10T12:00:00.000Z",
        "internal": false,
        "live": false,
        "cwd": "/work/project",
        "created_at": "2026-08-01T12:00:00.000Z",
        "updated_at": "2026-08-10T12:00:00.000Z",
        "persistence_session_id": "provider-session-id"
      }
    ],
    "next_cursor": null,
    "has_more": false
  }
}
```

`live` is provenance for `status_raw`: `true` means it was read from the live
`AgentManager` lifecycle. `false` means the record is persisted-only and
`status_raw` is the historical `lastStatus`, not a claim about current runtime
lifecycle. When both representations exist, the live record supplies
`status_raw`, `cwd`, timestamps, and provider session correlation; persisted
metadata supplies archived/internal state where relevant.

Clients discover this RPC through
`server_info.features.inventorySessionsSnapshot === true`. The CLI exposes the
same one-page contract as `paseo inventory sessions --json` and accepts
`--snapshot-id`, `--cursor`, and `--limit` for continuation. It rejects every
non-integer or out-of-range `--limit` locally (including `0`, floats, text, and
values above 200). Clients do not probe an old daemon with an unknown RPC: the
CLI reports `UNSUPPORTED_BY_HOST` when the feature is absent.
