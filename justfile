#!/usr/bin/env just --justfile
# Task runner for Serenity. Run `just` to see all recipes.
# `proj` recipes wrap the bin/proj CLI; web/native recipes proxy to the
# corresponding tooling.

set shell := ["bash", "-uc"]
set positional-arguments

default:
    @just --list

# ─── proj naming/rename tooling ────────────────────────────────────────────
# Smoke-test the project: folder, github, vercel, urls, drift.
validate:
    @bin/proj validate

# Same as `validate` but machine-readable JSON.
validate-json:
    @bin/proj validate --json

# Same as `validate` but skip network checks (offline / CI hot path).
validate-offline:
    @bin/proj validate --skip-network

# List every file still referencing a previousSlug / previousDisplayName.
drift:
    @bin/proj drift

# Print resolved project config + key paths.
config:
    @bin/proj config

# Show past rename events.
history:
    @bin/proj history

# End-to-end rename: just rename old new "New Display Name"
#   e.g. just rename pcod-tracker serenity "Serenity"
rename old new display="":
    @if [ -z "{{display}}" ]; then \
        bin/proj rename --to "{{new}}"; \
    else \
        bin/proj rename --to "{{new}}" --display "{{display}}"; \
    fi

# Dry-run a rename: just rename-preview new
rename-preview new:
    @bin/proj rename --to "{{new}}" --dry-run

# Self-tests for the proj CLI.
test-proj:
    @bin/proj-tests.sh
