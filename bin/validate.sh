#!/usr/bin/env bash
# Back-compat shim. Delegates to `proj validate`.
exec "$(dirname "$0")/proj" validate "$@"
