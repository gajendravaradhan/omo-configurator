#!/usr/bin/env bash
# =============================================================================
# omo-plutus setup — reset, apply patch, verify.
#
# Safe to re-run. Always resets the repo to committed state first, so a
# half-applied patch (the "already exists in working directory" / "patch does
# not apply" mess) is cleaned up automatically rather than compounding.
#
#   ./plutus-setup.sh              apply + test + preview to /tmp
#   ./plutus-setup.sh --live       also write the real ~/.omo/omo.jsonc
#   ./plutus-setup.sh --reset-only just clean the repo, change nothing else
#
# Files preserved across the reset: omo-plutus-fixes.patch, inventory.yaml,
# and this script.
# =============================================================================
set -uo pipefail

PATCH="omo-plutus-fixes.patch"
INVENTORY="inventory.yaml"
PREVIEW="/tmp/preview.omo.jsonc"
SELF="$(basename "$0")"
LIVE=0
RESET_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --live)       LIVE=1 ;;
    --reset-only) RESET_ONLY=1 ;;
    -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()  { red "FAILED: $*"; exit 1; }

# --- 0. sanity ---------------------------------------------------------------
step "Checking environment"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repo. cd to omo-configurator first."
[ -f package.json ] || die "no package.json here — wrong directory?"
grep -q '"name": *"omo-plutus"' package.json || ylw "warning: package.json name is not omo-plutus — continuing anyway"
command -v bun >/dev/null 2>&1 || die "bun not found on PATH."
echo "repo:  $(pwd)"
echo "bun:   $(bun --version)"
echo "head:  $(git log --oneline -1)"

# --- 1. preserve user files, then hard reset ---------------------------------
step "Resetting repo to committed state"
TMPKEEP="$(mktemp -d)"
for f in "$PATCH" "$INVENTORY" "$SELF"; do
  [ -f "$f" ] && cp -p "$f" "$TMPKEEP/" && echo "preserved: $f"
done

# Discard tracked modifications AND untracked files. This is what makes a
# half-applied patch recoverable: `git checkout .` alone leaves new untracked
# files behind (src/budget.ts, the fixtures), which is exactly what makes the
# next `git apply` fail with "already exists in working directory".
git reset --hard HEAD >/dev/null 2>&1 || die "git reset failed"
git clean -fdx -e node_modules -e bun.lock >/dev/null 2>&1 || die "git clean failed"

for f in "$PATCH" "$INVENTORY" "$SELF"; do
  [ -f "$TMPKEEP/$f" ] && cp -p "$TMPKEEP/$f" . && echo "restored:  $f"
done
rm -rf "$TMPKEEP"
grn "repo clean at $(git log --oneline -1)"

if [ "$RESET_ONLY" -eq 1 ]; then
  grn "Reset complete (--reset-only). Nothing else changed."
  exit 0
fi

# --- 2. apply the patch ------------------------------------------------------
step "Applying $PATCH"
[ -f "$PATCH" ] || die "$PATCH not found in $(pwd). Download it into the repo root."

if ! git apply --check "$PATCH" 2>/tmp/plutus-apply-err.txt; then
  red "Patch will not apply cleanly. Details:"
  cat /tmp/plutus-apply-err.txt
  echo
  ylw "Most likely cause: the repo HEAD moved since the patch was generated."
  ylw "Current HEAD: $(git log --oneline -1)"
  ylw "Patch was generated against: 1cf8d9d"
  die "aborting without changing anything"
fi

git apply "$PATCH" || die "git apply failed after --check passed (unexpected)"
grn "patch applied"

# --- 3. inventory ------------------------------------------------------------
step "Ensuring $INVENTORY exists"
if [ -f "$INVENTORY" ]; then
  echo "$INVENTORY already present — leaving it alone"
else
  cat > "$INVENTORY" <<'YAML'
# omo-plutus inventory.
# cap          = fraction of the window still remaining (0..1), or null if unknown
# window_tokens= ABSOLUTE window capacity in tokens, or null if unknown
#
# Both null => budget enforcement is SKIPPED for that provider and the run is
# quality-optimal only. Populate via `plutus discover --write` or by hand.
# Nothing here is guessed on your behalf: a wrong capacity silently poisons
# every recommendation downstream.
version: 1
providers:
  openai:
    cap: null
    window_tokens: null
    trust: user_declared
  opencode-go:
    cap: null
    window_tokens: null
    trust: user_declared
  deepseek:
    cap: null
    window_tokens: null
    trust: user_declared
demand:
  default_tokens: 250000
  sigma: 0.8
  observed_span_hours: 168
YAML
  grn "created $INVENTORY (all capacities null — budget NOT enforced yet)"
fi

# --- 4. deps + typecheck -----------------------------------------------------
step "Installing dependencies"
bun install >/dev/null 2>&1 || die "bun install failed"
grn "dependencies ok"

step "Typechecking"
if bunx tsc --noEmit 2>/tmp/plutus-tsc.txt; then
  grn "tsc clean"
else
  red "TypeScript errors:"; head -20 /tmp/plutus-tsc.txt; die "typecheck failed"
fi

# --- 5. tests ----------------------------------------------------------------
step "Running test suite"
bun test 2>&1 | tee /tmp/plutus-test.txt | tail -25
FAILCOUNT="$(grep -Eo '^ *[0-9]+ fail' /tmp/plutus-test.txt | grep -Eo '[0-9]+' | head -1)"
PASSCOUNT="$(grep -Eo '^ *[0-9]+ pass' /tmp/plutus-test.txt | grep -Eo '[0-9]+' | head -1)"
if [ "${FAILCOUNT:-1}" != "0" ]; then
  die "${FAILCOUNT:-?} test(s) failing — stopping before touching any config"
fi
grn "${PASSCOUNT} pass, 0 fail"

# --- 6. preview --------------------------------------------------------------
step "Generating preview (no live config touched)"
rm -f "$PREVIEW"
set +e
bun run src/cli/index.ts optimize --config "$INVENTORY" --output "$PREVIEW" --no-merge 2>&1 | tee /tmp/plutus-preview.txt
PREVIEW_RC="${PIPESTATUS[0]}"
set -e

case "$PREVIEW_RC" in
  0) grn "preview generated" ;;
  3) ylw "exit 3 — slots over-committed OR a spike is unresolved. Config still written; see output above." ;;
  2) die "exit 2 — validation failure" ;;
  *) die "optimize exited $PREVIEW_RC" ;;
esac

if grep -q "NOT enforced" /tmp/plutus-preview.txt; then
  ylw "NOTE: budget NOT enforced — every window_tokens is null."
  ylw "      Assignments are quality-optimal only; consumption limits are NOT applied."
  ylw "      Next: bun run src/cli/index.ts discover --write   (then edit any gaps by hand)"
fi

if [ -f "$PREVIEW" ]; then
  step "Assignments"
  bun -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const stripped = raw.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (m) => (m.startsWith("\"") ? m : "")).replace(/,(\s*[}\]])/g, "$1");
    const doc = JSON.parse(stripped);
    const oc = doc["[opencode]"] ?? doc;
    for (const sec of ["agents", "categories"])
      for (const [k, v] of Object.entries(oc[sec] ?? {}))
        console.log("  " + k.padEnd(22) + (v.model ?? "?") + (v.variant ? " (" + v.variant + ")" : ""));
  ' "$PREVIEW" 2>/dev/null || sed -n '1,40p' "$PREVIEW"
fi

# --- 7. live write (opt-in) --------------------------------------------------
if [ "$LIVE" -eq 1 ]; then
  step "Writing LIVE config (~/.omo/omo.jsonc)"
  set +e
  bun run src/cli/index.ts optimize --config "$INVENTORY"
  LIVE_RC=$?
  set -e
  case "$LIVE_RC" in
    0) grn "live config written; previous version backed up to omo.jsonc.bak.<timestamp>" ;;
    3) ylw "exit 3 — written, but capacity cannot cover demand. Review the report." ;;
    *) die "live write exited $LIVE_RC" ;;
  esac
  echo "  undo with: bun run src/cli/index.ts rollback --to latest"
fi

# --- done --------------------------------------------------------------------
step "Done"
echo "  preview config : $PREVIEW"
echo "  test log       : /tmp/plutus-test.txt"
[ "$LIVE" -eq 0 ] && echo "  to write live  : ./$SELF --live"
exit 0
