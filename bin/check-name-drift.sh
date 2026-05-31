#!/usr/bin/env bash
# Back-compat shim. Delegates to `proj drift`.
exec "$(dirname "$0")/proj" drift "$@"
