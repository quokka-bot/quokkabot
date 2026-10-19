# Egress service

Set `QUOKKABOT_EGRESS_CONFIG` to an `EgressConfig` JSON file. `src/main.ts` validates it, reads the control token
from `control.tokenFile`, and starts the configured listeners. A trailing newline in the token file is allowed;
the token itself must be nonempty and contain no whitespace. The normal workspace build must build shared
contracts before this application's runtime is launched. No new dependencies are needed.

`createEgress({ config, controlToken, resolver?, connector?, now?, onDecision? })` returns `start()`, `close()` and
`addresses()`. Configured ports must be valid, distinct endpoints; tests obtain unused loopback ports. The optional
resolver supplies `resolve4(host)` and `resolve6(host)`; the connector receives `{ address, family, port }` and
returns a connecting `net.Socket`. Production DNS uses only the configured servers and production TCP connects
use a validated numeric address. Each decision goes to stdout as one shared-contract JSON event unless an
`onDecision` callback is provided by an embedded caller.

Authorization happens before DNS. An absent snapshot or absent agent is frozen. Browser connections belong to
the task active when they opened; changing that task closes them even if a global rule still matches. All pending
DNS/connect work, HTTP transfers and CONNECT tunnels are tracked. Policy replacement, freeze, rule expiry and
attended-session closure revoke affected work. Freeze lasts until a newer snapshot replaces it. Idle sockets and
DNS/connect waits are bounded. Partial DNS errors other than no-record answers fail closed.

Absolute HTTP requests always use a single client connection, reconstruct the authorized Host, remove hop-by-hop
headers in both directions and reframe streamed bodies. Pipelined requests and HTTP upgrades are refused. TLS
CONNECT tunnels are not inspected; the stage-1 design trusts Chromium's TLS/network stack. Deploy this service
with the prescribed isolated sandbox networks and host firewall so direct connections cannot bypass it.

Every control route requires `Authorization: Bearer <token>`, including `/health`. Policy uploads require
`Content-Type: application/json`, are bounded to 2 MiB and reject invalid expiry dates. Successful responses are:

- `PUT /v1/policy`: `{ ok: true, revision }`; stale revisions return 409.
- `POST /v1/agents/:agentId/freeze`: `{ closed }`, including pending work closed.
- `GET /v1/connections`: `{ agents: { [agentId]: { cli: { count, hosts }, browser: { count, hosts } } } }`.
  Counts include pending DNS/connect work and transfers; hosts are unique and sorted.
- `GET /v1/decisions?after=0&wait=25`: `{ epoch, events }`, increasing sequence, last 10,000 events retained.
  A cursor older than the buffer gets the retained suffix; readers detect gaps from the sequence. The buffer and
  sequence are process-local. The random UUID epoch stays fixed for that decision store and changes on restart;
  control must reset its cursor to zero when the response epoch changes, including on an empty response.
- `GET /health`: `{ ok: true, revision }`; revision is zero before the first snapshot.

Verification, from the repository root:

```sh
corepack pnpm@12.14.0 --filter @quokkabot/egress typecheck
corepack pnpm@12.14.0 exec vitest run --project egress
```

The project test config aliases the frozen shared source contracts locally; it does not require generated shared
files. The real-socket suite probes loopback once and skips only on EPERM/EACCES. Run it on a host that permits
loopback listeners before deployment. Unit tests cover range boundaries, embedded addresses, host parsing,
policy semantics, configuration checks, resolver configuration and the decision ring.
