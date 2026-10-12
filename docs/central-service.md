# Adam Dashboard central service and remote worker

This opt-in Linux deployment runs one central Adam Dashboard server and a worker on each execution machine as systemd **user** services. Once installed with lingering enabled, each service starts at boot, survives logout, and restarts after exit. Daily use does not require starting both sides manually. This generator does not configure a reverse proxy, migrate data, or change the installed Codex App.

The central server starts `server/index.mjs` with `CODEX_TASKBOARD_MODE=central`, a shared `CODEX_TASKBOARD_SERVICE_TOKEN`, and `CODEX_TASKBOARD_DATA_DIR`. It always binds `127.0.0.1` in the generated configuration. The remote worker starts `scripts/execution-worker.mjs` with the server URL, the same token, a unique worker ID and name, allowed workspace roots, and its own persistent data directory. The worker connects outbound; it does not need an inbound public listener.

The runtime environment API retains the `CODEX_TASKBOARD_*` names. The new service names and directories apply to new deployments only; existing installed resources are not renamed or migrated.

## Prepare each host

Use a dedicated Linux account with a working systemd user manager, Node >=22.5, and a stable `adam-dashboard` checkout containing both executables. Install repository dependencies and build web assets (`npm ci`, then `npm run build:web`) before deployment. Keep the checkout and Node executable in stable locations; the unit stores absolute paths. Provision the worker's required execution tools and credentials for this same account. Its unit environment records the rendering user's PATH because systemd does not source interactive shell profiles.

Provision one long random service token on the central host and securely deliver the same token to each authorized worker. Do not put it in a command argument, unit file, Git, or shared logs. For example, create a new token file once:

```sh
install -d -m 700 "$HOME/.config/adam-dashboard-secrets"
(umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$HOME/.config/adam-dashboard-secrets/service-token")
```

The token file must contain only the token, **without a trailing newline**. Do not rerun this command to rotate an active deployment accidentally. The generator also accepts `CODEX_TASKBOARD_SERVICE_TOKEN` from its environment. Generated environment files are secrets too: keep the render directory private and remove disposable copies after inspection. File protection does not hide secrets from the service account or root.

## Render without installation

Run on each intended host as its service account. Rendering is the default and never calls systemctl. Use a fresh output directory on each run. Replace the example workspace path and HTTPS endpoint with the real ones.

Central host:

```sh
node scripts/install-central-service.mjs \
  --role central \
  --public-origin https://taskboard.example.com \
  --output-dir "$HOME/adam-dashboard-central-preview" \
  --token-file "$HOME/.config/adam-dashboard-secrets/service-token"
```

Worker host:

```sh
node scripts/install-central-service.mjs \
  --role worker \
  --output-dir "$HOME/adam-dashboard-worker-preview" \
  --token-file "$HOME/.config/adam-dashboard-secrets/service-token" \
  --server-url https://adam-dashboard.example.com \
  --worker-id execution-01 \
  --worker-name 'Execution host 01' \
  --workspace-roots '["/home/coder/repo"]'
```

Each directory contains `adam-dashboard-ROLE.service` and `adam-dashboard-ROLE.env`. Preview units reference the environment file in that preview directory; they are review artifacts. For installation, rerun the generator with `--install` and a fresh output directory; it renders units referring to the installed environment file instead. Do not manually copy a preview unit and then delete its referenced environment file.

Options `--repo-dir`, `--node`, and `--data-dir` override absolute paths. Central `--port` defaults to 47823. Default data directories are `~/.local/share/adam-dashboard/central` and `~/.local/share/adam-dashboard/worker`. Worker IDs must differ across hosts. JSON workspace roots must be absolute paths on the worker, not paths on the central host. When rendering for a different host, explicitly supply its paths and check the worker PATH before installation. Control characters and newlines are rejected in paths and environment values.

## Remote connectivity and authentication

Put an authenticated TLS reverse proxy on the central host in front of `http://127.0.0.1:47823`. Use a trusted certificate and expose only HTTPS to the intended clients/workers, restricted by your network policy. Preserve the original Host header and the authorization header required by the central service and any streaming/upgrade behavior used by the application. All remote requests must still pass central service-token authentication; do not strip authentication or add bypass routes. Do not place the shared token in URLs or access logs. Pass its exact HTTPS origin with `--public-origin`; this writes `CODEX_TASKBOARD_TRUSTED_ORIGINS`, which the server requires for non-private hostnames. Configure and verify the proxy against the central server before installing the remote worker.

For browser Basic authentication, use username `adam-dashboard` and the configured service token as the password over HTTPS. This is the target username for the renamed backend; deploy the corresponding backend change before using these credentials. Renaming the generated units alone does not change backend authentication.

The generator deliberately does not offer a public bind option. It rejects remote `http://` worker endpoints. Loopback HTTP is permitted for same-host operation. It does not provision DNS, certificates, proxy credentials, or firewall rules.

## Deliberate data cutover

The installer does not discover, copy, or migrate existing boards. The central data directory is a separate deployment. **Before a production switch**, deliberately select the source board and create a consistent SQLite backup using SQLite's backup API or `.backup` command. Never copy only a live `taskboard.sqlite` while ignoring its WAL. Coordinate a maintenance window: stop writes, take the final consistent backup, and copy the database plus required associated data/assets with ownership and permissions for the service account. Verify the destination contents and keep the original backup before switching clients. Do not run competing writers against the copied dataset during cutover. Data selection and migration are operator work, not generator side effects.

## Explicit installation and boot persistence

Only after configuration, authentication, and the data decision have been checked, rerun the appropriate render command with a **new** `--output-dir` and `--install`. On Linux this writes:

- `$XDG_CONFIG_HOME/systemd/user/adam-dashboard-ROLE.service` (default configuration home: `~/.config`).
- `$XDG_CONFIG_HOME/adam-dashboard-ROLE/adam-dashboard-ROLE.env`, with mode 0600 in a private directory.
- The selected data directory, if missing, with mode 0700.

Existing render or installed files are not overwritten. Existing secret/data directories must already be owned by the current user and private (0700). Installation calls `systemctl --user daemon-reload` then `systemctl --user enable --now adam-dashboard-ROLE.service`. It does not invoke sudo. A working user manager is required; a failure leaves files for inspection and reports an error rather than claiming success.

An administrator may need to authorize lingering **once on each host** so its user services start at boot without an interactive login:

```sh
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

The generator does not change lingering policy. Without `Linger=yes`, enabling a user unit alone does not guarantee unattended startup after reboot or survival after logout.

Inspect the appropriate role on each host:

```sh
systemctl --user status adam-dashboard-central.service
journalctl --user -u adam-dashboard-central.service -n 50
# On the execution host:
systemctl --user status adam-dashboard-worker.service
journalctl --user -u adam-dashboard-worker.service -n 50
```

Verify an authenticated central request, the worker's registration/heartbeat in the board, and one real dispatch into an allowed workspace before relying on the deployment. Reboot/logout persistence must be verified on the Linux deployment hosts; a successful render does not prove it. Ensure service logs do not disclose the token before sharing diagnostics.

To stop a deployment, use `systemctl --user disable --now adam-dashboard-ROLE.service`. Retain data and backups. For later configuration changes, edit the installed private environment file deliberately and restart that role; changes to a unit also require `systemctl --user daemon-reload`. This tool is a first-install generator, not an updater or deployment manager.

## Current central execution scope

The central service owns the database, task-to-conversation pointer, queue and results. Workers own only local execution receipts and a durable event outbox, not another board. The browser signs in with username `adam-dashboard` and the service token. Use one trusted owner/account; this release does not implement multi-user roles or separately scoped worker credentials.

A task continues its existing worker conversation unless the user explicitly starts a new one. Opening a conversation does not execute it. Job completion does not mark a task accepted or done. Queueing is durable; lost event acknowledgements are deduplicated. A disconnected running worker is not reassigned. On worker process restart, an unfinished local receipt is reported as interrupted rather than blindly rerunning code that may have already had side effects; the user can continue the same conversation. Keep the worker data directory and worker ID stable.

Plain-text turns and uploaded attachments are supported. Native Codex conversations from the old installation remain historical records; automatic reassignment to a worker is not implemented. Remote Skill/agent references, explicit compaction, native Mac navigation, Jira local configuration and automatic todo scheduling are not part of this central execution path. The legacy desktop code remains available separately. The generated Linux service files have been rendered locally, not installed or reboot-tested on a development host.
