# Live dashboard sharing

The hosted sharing site is deployed separately from the local dashboard. Configure your own deployment and credentials.

The macOS user LaunchAgent `com.adam.dashboard-share-sync` reads the configured board SQLite database in read-only mode every 10 seconds. It runs independently of the sidebar/Launcher. The hosted page reads `/api/tasks` every 5 seconds. The shared site retains the existing workspace-only audience.

Only title, short English description, status and update time reach the shared data store. New or edited title/description text is summarized by an ephemeral Codex CLI invocation, then cached locally by content hash. Raw task objects, project names, IDs, comments, attachments and bindings are not uploaded. Tasks awaiting a valid English summary are omitted until generation succeeds. Status-only changes reuse cached summaries.

The Worker validates the sync secret, projects allowed fields and stores them in R2. The local ignored `.data/share-sync.json` holds the supported Sites service credential and separate write secret. It must not be committed or copied to browser code. Sites credentials and the local Codex login must remain valid.

The website remains available when the Mac is asleep; data stops advancing and the page marks synchronization offline after 45 seconds. This is near-real-time polling, not a server-owned source of truth. A permanently available source host is required for updates while the Mac is offline.

## Operation

After installation, no open terminal or Dashboard sidebar is needed. The sync agent starts at user login.

- One sync: `node scripts/share-sync.mjs --once`
- Foreground sync: `node scripts/share-sync.mjs`
- Install on a new setup, after configuring credentials: `node scripts/install-share-sync.mjs`
- Stop: `launchctl bootout gui/$(id -u)/com.adam.dashboard-share-sync`
- Logs: `.data/share-sync.log`, `.data/share-sync-error.log`

Do not run a foreground writer and the LaunchAgent simultaneously.

The hosted site source is maintained in a separate deployment checkout and is not included in this repository. Edit `public/` and `worker/handler.js`; run `node scripts/embed.mjs`, `bash scripts/build.sh`, and `node scripts/validate-artifact.mjs` before publishing through Sites. Routine task updates do not redeploy the site.
