# Checkout phase context

Checkout phase diagnostics use `AsyncLocalStorage` because the measured work crosses promise
boundaries owned by the refresh service, the Git scheduler, and Forge adapters. The request owns its
bounded row buffer and slow-request deadline; a shared refresh owns the active spans and cycle
identity, while each subscriber retains its own request ID and observation time. This keeps
correlation local to one checkout operation without changing Git, cache, or refresh policy.

The context is internal and best-effort. Rows carry fixed phase labels and allowlisted scalar fields,
and sink failures cannot change the checkout result. The older worker-backed path has separate
ownership and must carry this correlation across its worker message boundary when instrumented.
