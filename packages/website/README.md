# Paseo website

## Plugin install counts

Clients report an install by resolving a plugin with `X-Paseo-Install: 1` or
`?intent=install`, using `/api/plugins/resolve/<owner>/<slug>` or
`/plugins/<owner>/<slug>.json`. Ordinary resolves do not count. These numbers
measure install intent, not successful artifact installation or npm downloads.

The worker requires Cloudflare's `CF-Connecting-IP` header to count a report.
It stores the plugin ID plus a SHA-256 hash of the IP in a `WEBSITE_CACHE` KV key
with a one hour TTL, never the raw IP. An existing key skips the count; repeats
do not extend the hour. Missing or empty IP headers do not count.

Accepted reports increment the existing all-time total and UTC daily buckets in
`WEBSITE_CACHE`. Daily buckets retain 60 days and supply the website's seven-day
and thirty-day rankings. `/api/plugins/installs` still returns plugin IDs mapped
to all-time totals. The [registry build](https://github.com/getpaseo/plugins/blob/main/scripts/build.ts)
reads that endpoint into the published plugin details and index; the website
reads windowed counts from KV through its five-minute cache. Existing counts
remain intact. The KV guard is advisory: concurrent requests and KV propagation
are not serialized.
