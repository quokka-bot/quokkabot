# Supervisor

The supervisor has the Docker socket and no network. `QUOKKABOT_SUPERVISOR_CONFIG` names a JSON file validated
by `src/config.ts`. Image references must include a sha256 digest. Provision the encrypted data volume, its
marker file, the socket parent directory and token/agent secret files before starting. The process needs
permission to chown sandbox data and MCP configuration files to UID/GID 1000. The supervisor socket is 0660;
deployment must give control the matching socket group. All routes, including `/health`, require the bearer
token from `tokenFile`. Tokens and browser secrets may have one trailing newline.

`src/templates.ts` owns every sandbox create body. `src/docker.ts` speaks Engine API v1.47 over the configured
unix socket. Neither users nor API requests can select images, mounts, users, Docker endpoints or exec targets.
Shell command strings are accepted only by the workspace exec operation in the tools sandbox.

Agent lifecycle operations are serialized. Kill fences new work immediately, fsyncs a persistent latch,
disconnects sandbox network endpoints, kills all sandboxes and verifies they stopped. Failed disconnects do not
prevent the remaining kills. A latched restart completes the kill before accepting authenticated requests.
After unlatch, start recreates disconnected containers to restore only their configured endpoints.

Run ids are reserved durably before Docker launch. Status files also retain the Docker exec id and cancellation
intent, without the prompt or MCP token. Output batches are fsynced before publishing their line count; status
renames are serialized and fsynced before publishing state transitions. Before admitting authenticated requests
on restart, every starting or running run is cancelled through the fixed process-group wrapper when its CLI
container is running, then marked lost with a null exit code. Orphaned execs are never resumed or monitored.
The supervisor also closes owner shells once in each running CLI container, even without a recorded run.
Startup fails if a helper cannot confirm closure. The cancel wrapper's documented exit code 3 means the run
never started in that sandbox and is safe to mark lost. Every recovery action is logged without raw output.

Session cleanup refuses active runs with 409. After the session helper and MCP file cleanup succeed, it deletes
the run's raw NDJSON output and status file. The run then returns 404; repeated cleanup succeeds without touching
another session. If deletion is interrupted after removing status, startup removes the remaining orphaned output.

Exports are spooled under the encrypted data root before sending HTTP headers, then streamed with backpressure.
This permits a nonzero helper exit to return 404/400 even when the helper emitted partial bytes. Temporary
exports are removed after delivery or failure and on restart. Export size is bounded by the shared file limit.
File operations and exports answer 409 `computer_stopped` while the tools sandbox is missing, created or exited,
and 409 `killed` behind the kill switch, without an exec. A helper that a stop or kill ends gets the same answer;
a helper that fails on its own keeps its error.
CLI output lines over 8 MiB fail the recorder and latch/kill the computer. Application logs contain operation
names, ids, error codes and command lengths; no prompts, command contents, output or terminal input.

Run from the repository root:

```sh
corepack pnpm@12.14.0 --filter @quokkabot/supervisor typecheck
corepack pnpm@12.14.0 exec vitest run --project supervisor
corepack pnpm@12.14.0 --filter @quokkabot/supervisor build
```

The test suite includes a fake Docker HTTP server on a temporary unix socket with upgraded raw/multiplexed exec
streams. When the host denies unix socket listening with EPERM/EACCES, those integration tests are explicitly
skipped. In-memory stream and HTTP handler tests still verify lifecycle order, kill persistence, strict schemas,
run launch/output/startup cancellation, session cleanup, files, exports and terminal reservation. Real Docker/runsc,
UID/GID ownership and terminal hangup behavior still need the deployment host fixture.
