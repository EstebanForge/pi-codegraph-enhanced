# Changelog

## 1.0.1 — 2026-06-25

Bugfix release for the `/codegraph init` command.

### Fixed
- **`/codegraph init` now gives visual feedback.** Previously the command
  was fire-and-forget with only a completion-time notify, leaving the user
  with no indicator that indexing had started or was running. The status bar
  now shows `CodeGraph: indexing…` for the whole duration, and the outcome
  (initialized / rebuilt / synced / busy / skipped / unavailable) updates it
  on completion.
- **Fixed UI surface for manual init.** `runManualInit` reached for
  `(pi as any)?.ui`, an untyped property that does not exist on the
  `ExtensionAPI` surface. This was plausibly why feedback was invisible at
  runtime. Reworked to route through `ctx.ui` / `ctx.hasUI` like the rest of
  the extension, so headless/print mode is now correctly skipped.
- **Unguarded UI calls can no longer crash the command.** All UI writes are
  now wrapped in a swallow helper, so a TUI glitch can neither reject the
  fire-and-forget chain nor cause an unhandled rejection from `.catch`.
- **`unavailable` now surfaces the install hint** (`npm i -g
  @colbymchenry/codegraph`) instead of a terse message, mirroring the
  startup auto-index path — the manual path is where users most need it.
- **Stale `indexing…` status is cleared on failure.** The previously silent
  `.catch(() => {})` now clears the status bar and notifies `CodeGraph: init
  failed` so a silent failure no longer leaves a hung indicator.

## 1.0.0 — 2026-06-25

First release of `@estebanforge/pi-codegraph`, a fork of
[`@vndv/pi-codegraph`](https://github.com/vndv/pi-codegraph) (itself a Pi
wrapper around [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)).
The tools, JSON-RPC MCP session handling, and Windows path resolution are
inherited from upstream; this release layers on automatic index management,
a hardened CLI runner, and user-facing feedback.

### Added
- **`codegraph-auto-index` flag + `/codegraph` command.** A boolean flag
  (default **false**, opt-in) gates CREATING new indexes on session start, so
  opening Pi in a folder never triggers indexing unless asked. Existing
  indexes are always kept fresh (sync/rebuild) regardless of the flag.
  `/codegraph` opens an interactive `SettingsList` menu in TUI (same component
  `/settings` uses) or a read-only status panel in headless mode.
  `/codegraph init` indexes the current folder on demand, ignoring the flag.
  `/codegraph toggle codegraph-auto-index` (shorthand: the bare flag name)
  does a one-shot flip that persists via `pi config set` and reloads. Mirrors
  the `/glm-tweaks` pattern. Tab-completion for `init`, `toggle`, and the
  flag name.
- **Auto-managed index on startup.** On `resources_discover` (once per
  session start and `/reload`), the extension runs a status gate and
  performs the cheapest action that leaves the index fresh:
  - `.codegraph/` missing → `codegraph init -i`
  - present with pending changes → `codegraph sync` (incremental)
  - present with unreadable / `initialized: false` / non-zero `status` →
    `codegraph index -f` (treat as corrupt)
  - clean → no-op
  - Never blocks the agent; the watcher inside `codegraph serve --mcp`
    remains the live safety net for in-session edits.
- **Fail-safe CLI probe.** A short `codegraph --version` check (10s cap)
  runs first. If the CLI is absent or broken, the gate returns `unavailable`
  immediately instead of spawning into an ENOENT or wasting the long
  timeout window. A failed `init` reports `unavailable` rather than a
  false `initialized`.
- **Cancellable CLI runner.** `CodeGraphRunner` now takes an
  `AbortSignal`; `runWithTimeout` aborts on a 5-minute cap (10s for the
  version probe) and the runner kills its child on abort. A timed-out or
  lock-busy `status` no longer escalates into an expensive forced reindex.
- **Concurrency handling.**
  - `ensureCodeGraphIndexOnce` dedups overlapping calls against the same
    project within a session via an in-flight `Map`.
  - Live lock conflicts (another active process holds the codegraph lock)
    are detected from stderr and surfaced as a `busy` action, never
    triggering a racing second writer.
  - `status` timeout or lock-busy → `busy` (skip), not `index -f`.
- **User-facing feedback.** The startup outcome is reported via
  `ctx.ui.setStatus` (`CodeGraph: initialized` / `synced` / `rebuilt` /
  `busy` / `unavailable`), guarded by `hasUI` for headless mode. A
  one-time warning notifies when the CLI is missing or broken.
- **New action variants** `unavailable` and `busy` on the
  `CodeGraphStartupAction` result type.
- **Tests.** 45 tests covering the full decision matrix (missing dir,
  drift, corrupt/unreadable status, status-timeout, lock-busy, clean
  no-op), real-spawn abort/kill coverage for the runner, the
  `runWithTimeout` timer chain, in-flight dedup, the auto-index flag gate
  (opt-in creation + always-on maintenance branches), and the `/codegraph`
  status panel.

### Changed
- **Shared Windows-aware spawn.** Extracted `spawnCodeGraphProcess(args, cwd, stdio)`
  + `windowsCodeGraphLaunchScript(args)` so the MCP server launcher and
  the startup CLI runner share one PowerShell `Get-Command` discovery
  path. The startup auto-index now works on Windows instead of silently
  self-disabling on shimmed installs.
- **Quieter output.** `index` / `sync` run with `-q`; commands whose
  output isn't parsed use `stdio: "ignore"` for stdout to avoid
  unbounded buffering on large repos.
- **Package identity.** Renamed to `@estebanforge/pi-codegraph`,
  restructured `package.json` (author, keywords, `peerDependenciesMeta`
  with optional peers), and dropped the upstream changeset / CI
  tooling.

### Fixed (vs. an earlier in-development revision of this fork)
- **Removed `indexIsLocked`.** A file-based lock check in the
  `statusFailed` branch blocked legitimate recovery: `codegraph index -f`
  reclaims stale locks (verified empirically), so a crash-leftover lock
  must not prevent a corrupt DB from being rebuilt. Live lock conflicts
  are still caught via stderr wording (`looksLikeLockFailure`); the
  stale-lock recovery path is now guarded by a regression test.
- **Timeout no longer leaks the child.** The previous `runWithTimeout`
  resolved the promise on timeout but never killed the spawned process,
  which could orphan a writer holding the codegraph lock and race a
  second `index -f` into DB corruption. Now killed via `AbortSignal`.

---

Prior history under the `@vndv/pi-codegraph` name (0.1.x) is preserved
upstream at <https://github.com/vndv/pi-codegraph>.
