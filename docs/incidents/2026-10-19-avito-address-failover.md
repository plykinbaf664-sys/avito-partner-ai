# Avito connection address failover

Read-only probes found that `176.114.124.2`, returned by Avito DNS, timed out
three times during TCP connection from production, while another current DNS
address answered in about 40 ms. The failing address was reachable directly from
the operator's computer. Another address occasionally delayed its response.
This demonstrates a path-specific connectivity problem, not the cause of every
HTTP 502. No fixed IP is added to production configuration.

The production service has legacy `--no-network-family-autoselection` settings.
Avito now uses its own Undici dispatcher with `autoSelectFamily: true`, a 250 ms
address-attempt interval and an 8-second connection limit. DNS alternatives are
tried before an HTTP request is sent. The existing 10-second request limit, TLS
verification, GET retry limits and outbound reconciliation remain in force.
The global dispatcher, DNS, VPN and other providers are unchanged.

The implementation follows Node's documented connection selection and Undici's
scoped Agent options:
- https://nodejs.org/api/net.html#socketconnectoptions-connectlistener
- https://github.com/nodejs/undici/blob/main/docs/docs/api/Agent.md

Two real-socket regressions first failed with process autoselection disabled:
fallback from an unreachable first DNS address, and exactly one accepted POST
when the response is lost. Both passed after the connection-only change. A client
regression also verifies that the default transport uses this dispatcher and
retains cancellation. Undici 7.30.1 is the only added dependency; existing locked
packages are unchanged.

Conversation code is unchanged; previously reviewed live conversation evidence
can be reused. Release checks include the full suite, types, lint, build, Linux
checks and read-only Avito probes with the failing DNS address placed first.
No test messages are sent to Avito or Telegram. A completed TCP connection followed
by an HTTP 502 or slow response remains a separate provider/path issue.

## Verified release

Deployed `a035090bf5fbabeb4c0e4c32246924dc56073cc8` on 2026-10-19 at 10:21 UTC.
Local and Linux checks passed: 668 tests in 50 files, typecheck, lint and build.
With global autoselection disabled and the failing address forced first, the
candidate connected to another current DNS address and received HTTP 404 from the
unauthenticated diagnostic endpoint in 810 ms. Auth, account and chat reads passed.
No customer messages or additional paid model calls were made by these checks;
unchanged conversation/provider evidence was reused and recorded in the manifest.

Production readiness returned HTTP 200 with no issues; the first four polling
cycles passed. Pending/failed inbound and unresolved outbound were zero; two old
failed deliveries were unchanged. Production checkout was clean.

Server evidence: `/root/.config/avito-partner-ai/avito-network-smoke-a035090bf5fb.json`.
Backup and rollback manifest:
`/opt/avito-partner-ai-backups/qwen-migration-20261019-102113/operational-release.json`.
The only runtime dependency addition is Undici; rollback can leave it unused.
