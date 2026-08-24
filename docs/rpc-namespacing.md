# RPC Namespacing

New WebSocket session RPCs use dotted names with the direction as the final segment:

```ts
checkout.forge.set_auto_merge.request;
checkout.forge.set_auto_merge.response;
```

The namespace reads left to right:

- Domain: `checkout`
- Namespace segment: `forge`
- Operation: `set_auto_merge`; this segment is a verb, not a noun. If you would name an RPC `noun.request`, name it `get_noun.request` instead.
- Direction: `request` or `response`

Use dots, not slashes. Dots are protocol namespaces; slashes imply paths or transport routing.

## Request/Response Pairs

For ordinary correlated RPCs, a `.request` has a matching `.response` with the same prefix. The daemon client may derive the response type mechanically:

```ts
checkout.forge.set_auto_merge.request;
// -> checkout.forge.set_auto_merge.response
```

Most new RPCs should follow this shape. If a request does not have a one-to-one response, call that out in the code near the schema.

## Message Shape

Requests keep their parameters at the top level:

```ts
{
  type: "checkout.forge.set_auto_merge.request",
  cwd: "/repo",
  enabled: true,
  mergeMethod: "squash",
  requestId: "req_123"
}
```

Responses put correlated result data under `payload`:

```ts
{
  type: "checkout.forge.set_auto_merge.response",
  payload: {
    cwd: "/repo",
    enabled: true,
    success: true,
    error: null,
    requestId: "req_123"
  }
}
```

Keep `requestId` in both request and response payloads. It is the correlation key.

## Forge Namespacing

Forge-neutral behavior currently uses `checkout.forge.*` for checkout-scoped operations and `forge.search.*` for forge search; forge-specific names belong here only after schema and session handlers exist:

- `checkout.forge.*` for operations whose request/response shape is genuinely
  forge-neutral and whose implementation dispatches through the forge resolver.
- `checkout.github.*` for existing GitHub-specific compatibility RPCs while
  callers migrate to the neutral `checkout.forge.*` shape

Do not put GitHub-specific enums or semantics into `checkout.forge.*` RPC names. A generic forge RPC should only exist when the behavior is genuinely forge-neutral.

## Compatibility

The existing flat RPC names remain part of the protocol until they are intentionally migrated:

```ts
checkout_pr_merge_request;
checkout_pr_merge_response;
```

Do not add new flat names. When migrating old RPCs, keep protocol compatibility rules in mind:

- Add the new names first.
- Gate new feature behavior through `server_info.features.*` when an old host cannot support it.
- Keep old names accepted until the compatibility window expires.
- Mark shims with `COMPAT(...)` and a removal date.
