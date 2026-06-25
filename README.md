# @estebanforge/pi-codegraph-enhanced

Pi-native [CodeGraph](https://github.com/colbymchenry/codegraph) tools with **automatic index management on every session start**. Fork of [`@vndv/pi-codegraph`](https://github.com/vndv/pi-codegraph): same eight structural-code tools, plus a startup gate that creates, syncs, or rebuilds the index so it's always fresh without you ever running `codegraph init` / `sync` by hand.

Ask pi structural questions about your codebase without falling back to slow grep/read loops.

## Install

```
pi install npm:@estebanforge/pi-codegraph-enhanced
```

CodeGraph itself must be installed and on `PATH`:

```
npm install -g @colbymchenry/codegraph
```

Then `/reload` in pi (or restart), and ask:

```
Use CodeGraph. Explain how authentication reaches the request handler.
Use CodeGraph. What would break if I change UserRepository?
Use CodeGraph. Show files under internal/services and important symbols.
```

## What it does

Two halves: the **tools** (unchanged from upstream) and the **auto-managed index** (the fork's reason for existing).

### Tools

Extension tools only, no MCP config to maintain. Each tool proxies one request to `codegraph serve --mcp`:

| Tool | Description |
| --- | --- |
| `codegraph_search` | Symbol search by name |
| `codegraph_node` | One symbol's signature, location, source, callers, and callees |
| `codegraph_files` | Indexed file tree |
| `codegraph_callers` | Functions or methods that call a symbol |
| `codegraph_callees` | Functions or methods called by a symbol |
| `codegraph_impact` | Impact radius for changing a symbol |
| `codegraph_explore` | Source for several related symbols grouped by file |
| `codegraph_status` | Index health and pending sync status |

### Auto-managed index

On every session start and `/reload`, the extension probes the `codegraph` CLI and, when available, runs a status gate that performs the cheapest action leaving the index fresh:

| State at startup | Action | Why |
| --- | --- | --- |
| `codegraph` not on `PATH` | nothing (`unavailable`) | Fail-safe: bail before any spawn, avoid a false "initialized" and wasted timeouts |
| `.codegraph/` missing | `codegraph init -i` | Create the index and build the graph in one step |
| `.codegraph/` present, `status` reports pending changes | `codegraph sync` | Incremental update for drift made outside the watcher (terminal `git pull`, another editor) |
| `.codegraph/` present, `status` unreadable / `initialized: false` / non-zero exit | `codegraph index -f` | Treat the DB as corrupt or half-initialized and rebuild it |
| `status` times out, or any command reports a live file-lock conflict | nothing (`busy`) | Another process owns the index (a `/reload` racing a long index). Skip rather than start a second writer or a wasteful full reindex |
| `.codegraph/` present, `status` clean | nothing (`skipped`) | Already fresh |

The maintenance runs fire-and-forget and never blocks the agent from starting. Outcome surfaces in the footer (`CodeGraph: initialized` / `synced` / `rebuilt` / `busy` / `unavailable`); a one-time warning fires if the CLI is missing. This replaces the daily `codegraph index && codegraph sync` habit, `index -f` only runs when `status` genuinely cannot read the DB.

## How it works

```
pi agent
  -> pi-codegraph extension tool
  -> local CodeGraph MCP process (codegraph serve --mcp --path <project>)
  -> .codegraph/codegraph.db
  -> structured result back to pi
```

On `resources_discover` (once per session start and `/reload`), the extension additionally runs the auto-managed index gate against the current project before any tool call.

## `/codegraph` command

Inspect and toggle the CodeGraph settings flag without leaving Pi.

| Invocation | Effect |
| --- | --- |
| `/codegraph` (TUI) | Opens an interactive settings menu (the same `SettingsList` component `/settings` uses). Flip the flag, then a single reload fires on close to apply it. |
| `/codegraph` (non-TUI / RPC) | Falls back to a read-only status panel: the flag's on/off state and the last startup action. |
| `/codegraph init` | Index the current folder now, regardless of the flag. Creates/syncs/rebuilds the `.codegraph` index on demand. |
| `/codegraph toggle <flag>` | One-shot flip: persists, then reloads. |
| `/codegraph <flag>` | Shorthand one-shot toggle (flag name without the `toggle` keyword). |

Tab-completion is offered for `init`, `toggle`, and the flag name.

The one flag today:

| Flag | Default | What it does |
| --- | --- | --- |
| `codegraph-auto-index` | `false` | Create the `.codegraph` index automatically in folders that don't have one, on every session start. Off by default so opening Pi in a folder never triggers indexing unless you ask. Existing indexes are always kept fresh (sync/rebuild) regardless of this flag. Use `/codegraph init` to index a specific folder on demand. |

**Two-tier behavior.** Creation is opt-in (flag, default off); maintenance is always-on. If a project already has a `.codegraph/` index (created via `/codegraph init`, a previous enabled session, or `codegraph init -i`), the extension keeps it fresh every startup, syncing drift and rebuilding on corruption, even with the flag off. The flag only controls whether to create new indexes in folders that have none.

**Why a reload per apply.** Pi's extension API exposes `getFlag` but no live `setFlag`, and flag values are read into memory at load time. Changes persist via `pi config set` and a `/reload` picks them up. You can also set flags directly: `pi config set codegraph-auto-index false`.

## Notes on concurrency and recovery

- **Cancellable runner.** Every CLI invocation is wrapped in an `AbortSignal` with a 5-minute cap (10 seconds for the `--version` probe). A hung command is aborted and its child process killed, so it can never orphan a writer holding the codegraph lock.
- **Lock conflicts.** `codegraph index -f` reclaims stale locks (verified against `@colbymchenry/codegraph`), so a crash-leftover lock never blocks recovery of a corrupt DB. A *live* lock (another active process) surfaces in stderr and is detected as `busy`, never escalated into a racing second writer.
- **In-flight dedup.** Concurrent calls against the same project within a session collapse into one operation. Cross-`/reload` overlap is backstopped by codegraph's own `.lock` file.
- **Windows parity.** The startup runner resolves the `codegraph` shim via the same PowerShell `Get-Command` discovery the MCP launcher uses, so global npm/Scoop installs are found. Shared `spawnCodeGraphProcess` helper used by both paths.

## Requirements

- Node.js 22.19.0 or newer (provided by pi).
- CodeGraph CLI on `PATH`: `npm install -g @colbymchenry/codegraph`.

## Credit

Fork of [`@vndv/pi-codegraph`](https://github.com/vndv/pi-codegraph) by the CodeGraph contributors, which itself wraps [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph). The tools, JSON-RPC MCP session, and Windows path handling are theirs; this fork adds the auto-managed index, the cancellable CLI runner, concurrency handling, and status feedback.

## License

MIT
