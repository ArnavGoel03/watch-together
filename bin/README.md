# `bin/` — Serenity project tooling

This directory contains `proj`, the CLI that manages project naming and
renames across local folder, GitHub, Vercel, native bundle IDs, and the
portfolio site. It is the single source of truth for keeping every surface
in sync.

```
bin/
├── proj                              # main CLI — run `proj help`
├── proj.bash                         # bash/zsh completion (source from your shell rc)
├── proj-tests.sh                     # self-tests, run `proj-tests.sh`
├── project.config.schema.json        # JSON Schema for ../project.config.json
├── README.md                         # this file
├── RENAME-WORKFLOW.md                # detailed step-by-step doc
├── RENAME-HISTORY.md                 # schema doc for the history log
│
└── (back-compat shims — call proj internally:)
    ├── validate.sh                   # → proj validate
    ├── check-name-drift.sh           # → proj drift
    └── log-rename.sh                 # → proj log
```

## Quick start

```sh
proj help                  # what commands exist
proj validate              # smoke-test (folder, github, vercel, urls, drift)
proj drift                 # find leftover references to old names
proj history               # past rename events
proj config                # resolved config + key paths
proj rename --to <slug>    # end-to-end rename orchestrator
```

All commands support `--help`, `--json`, `--quiet`, `--no-color`.

## Subcommands

| Command    | Purpose                                                              | Network? |
|------------|----------------------------------------------------------------------|----------|
| `validate` | Smoke-test that config matches reality across every surface          | Yes (use `--skip-network` to disable) |
| `drift`    | List every line in repo+portfolio that references a previous name    | No       |
| `rename`   | End-to-end rename: config → sed → folder mv → gh → vercel → log      | Yes      |
| `log`      | Append a rename event to `.rename-history.jsonl`                      | No       |
| `history`  | Show past rename events (pretty or `--json`)                          | No       |
| `config`   | Print resolved config + key paths                                    | No       |
| `doctor`   | Verbose validate                                                     | Yes      |

## Exit codes

| Code | Meaning |
|-----:|---------|
|   0  | Success |
|   1  | Expected failure (drift detected, validate failed, rename declined) |
|   2  | Usage error (missing arg, unknown flag) |
|   3  | Config error (malformed `project.config.json`, missing required field) |
|   4  | Internal error (impossible state, tool bug) |

## Dependencies

| Tool | Required for                          |
|------|----------------------------------------|
| `jq`   | All commands (config parsing)         |
| `git`  | `drift`, `validate`, `rename`         |
| `curl` | `validate` URL probes, `rename` Vercel API |
| `gh`   | `validate` GitHub reachability, `rename` repo rename |
| `perl` | Portable `timeout` for `drift` (macOS lacks coreutils' `timeout`) |

`jq`, `git`, `curl`, `perl` ship on macOS. Install `gh` via `brew install gh`.

## Setting up shell completion

```sh
# bash (~/.bashrc) or zsh (~/.zshrc with bashcompinit):
source ~/Documents/Projects/serenity/bin/proj.bash
```

## Pre-push safety net

Optional but recommended — a Husky pre-push hook that runs `proj validate`
so a rename can never silently leave drift on push:

```sh
# .husky/pre-push
bin/proj validate --skip-network || {
  echo "✗ proj validate failed. Fix drift before pushing, or use --no-verify."
  exit 1
}
```

## Adopting this in another project

```sh
# from the project you want to set up:
cp ~/Documents/Projects/serenity/bin/* ./bin/
cp ~/Documents/Projects/serenity/justfile ./
# Then create ./project.config.json (use serenity's as a template).
# Then run:
./bin/proj validate
```

Or wait — only adopt this when you're about to rename. Lazy rollout beats
preemptive scaffolding.
