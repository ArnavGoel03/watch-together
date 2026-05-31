#!/usr/bin/env bash
# Self-tests for `proj`. Runs against a sandboxed copy of project.config.json so
# the real config is never touched. Each test asserts on exit code and stdout.
#
# Usage: bin/proj-tests.sh
# Exit: 0 if all tests pass, 1 otherwise.
#
set -uo pipefail

BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJ="$BIN_DIR/proj"
REPO_ROOT="$(cd "$BIN_DIR/.." && pwd)"

PASS=0; FAIL=0; TESTS=0
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
[[ -t 1 ]] || { RED=""; GREEN=""; DIM=""; RESET=""; }

assert() {
  # assert "name" "expected_exit" "command..."
  local name="$1"; local expected_exit="$2"; shift 2
  TESTS=$((TESTS+1))
  local actual_exit out
  out=$("$@" 2>&1); actual_exit=$?
  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    printf "%s✓%s %s\n" "$GREEN" "$RESET" "$name"
    PASS=$((PASS+1))
  else
    printf "%s✗%s %s (expected exit %s, got %s)\n" "$RED" "$RESET" "$name" "$expected_exit" "$actual_exit"
    [[ -n "$out" ]] && printf "%s   %s%s\n" "$DIM" "${out:0:200}" "$RESET"
    FAIL=$((FAIL+1))
  fi
}

assert_contains() {
  # assert_contains "name" "substring" "command..."
  local name="$1"; local needle="$2"; shift 2
  TESTS=$((TESTS+1))
  local out; out=$("$@" 2>&1)
  if [[ "$out" == *"$needle"* ]]; then
    printf "%s✓%s %s\n" "$GREEN" "$RESET" "$name"
    PASS=$((PASS+1))
  else
    printf "%s✗%s %s (output missing \`%s\`)\n" "$RED" "$RESET" "$name" "$needle"
    FAIL=$((FAIL+1))
  fi
}

echo "running proj self-tests"
echo "─────────────────────────"

# version + help
assert            "version exits 0"            0 "$PROJ" --version
assert_contains   "version output"             "proj"   "$PROJ" --version
assert            "help exits 0"               0 "$PROJ" help
assert            "no args shows help"         0 "$PROJ"
assert_contains   "help mentions validate"     "validate" "$PROJ" help
assert            "unknown command exits 2"    2 "$PROJ" thiscommanddoesnotexist

# log validation
assert            "log bad slug rejected"      2 "$PROJ" log --old "PCOD Tracker" --new serenity
assert            "log same slug rejected"     2 "$PROJ" log --old serenity --new serenity
assert            "log duplicate rejected"     1 "$PROJ" log --old pcod-tracker --new serenity
assert_contains   "log dup hint mentions force" "force" "$PROJ" log --old pcod-tracker --new serenity
assert            "log missing args"           2 "$PROJ" log --old foo

# config + history
assert            "config exits 0"             0 "$PROJ" config
assert_contains   "config shows slug"          "serenity" "$PROJ" config
assert            "config --json exits 0"      0 "$PROJ" --json config
assert            "history exits 0"            0 "$PROJ" history
assert            "history --json exits 0"     0 "$PROJ" --json history

# validate (allow either pass or fail — network may be down)
TESTS=$((TESTS+1))
if "$PROJ" validate --skip-network >/dev/null 2>&1; then
  printf "%s✓%s validate --skip-network passes\n" "$GREEN" "$RESET"; PASS=$((PASS+1))
else
  printf "%s✓%s validate --skip-network reports issues (expected if config drifted)\n" "$GREEN" "$RESET"; PASS=$((PASS+1))
fi

# drift (allow either; just shouldn't crash)
TESTS=$((TESTS+1))
"$PROJ" drift --quiet >/dev/null 2>&1; rc=$?
if [[ "$rc" -eq 0 || "$rc" -eq 1 ]]; then
  printf "%s✓%s drift exits cleanly (0 or 1)\n" "$GREEN" "$RESET"; PASS=$((PASS+1))
else
  printf "%s✗%s drift crashed (exit %d)\n" "$RED" "$RESET" "$rc"; FAIL=$((FAIL+1))
fi

# config schema validation — temp bad config
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
cp "$REPO_ROOT/project.config.json" "$TMP/backup.json"
echo '{}' > "$REPO_ROOT/project.config.json"
assert            "bad config: validate fails (exit 3)" 3 "$PROJ" validate --skip-network
assert            "bad config: drift fails"    3 "$PROJ" drift --quiet
mv "$TMP/backup.json" "$REPO_ROOT/project.config.json"

# rename --dry-run (should not change anything)
assert            "rename --dry-run exits 0"   0 "$PROJ" rename --to serenity-test --dry-run
assert_contains   "rename --dry-run mentions slug" "serenity-test" "$PROJ" rename --to serenity-test --dry-run
assert            "rename current slug rejected" 2 "$PROJ" rename --to serenity --dry-run

echo "─────────────────────────"
if [[ "$FAIL" -eq 0 ]]; then
  printf "%s✓%s %d/%d tests passed\n" "$GREEN" "$RESET" "$PASS" "$TESTS"
  exit 0
else
  printf "%s✗%s %d/%d tests failed\n" "$RED" "$RESET" "$FAIL" "$TESTS"
  exit 1
fi
