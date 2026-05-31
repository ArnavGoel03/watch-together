#!/usr/bin/env bash
# Back-compat shim. Delegates to `proj log`.
exec "$(dirname "$0")/proj" log "$@"
