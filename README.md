# omo-plutus

**Quality-optimal legal assignment emitter for [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode).**

`omo-plutus` reads your live subscription quota (via `plutus discover`), joins it against
oh-my-openagent's legal model-fallback chains and live model availability, solves a
per-slot assignment (which model should run each agent/category slot), and emits a
**schema-validated `oh-my-opencode.json`** plus an **auditable `plutus-report.md`**.

> **v1 does not enforce budget.** It emits quality-optimal legal assignments and reports
> projected consumption. Live budget coupling, shadow prices, and adaptive rebalancing
> are v2, gated on SPIKE-02 and SPIKE-06.

Built for **Bun** + TypeScript. The solver pipeline makes **zero network calls** —
everything except live quota is derived from local, version-pinned artifacts (the
installed oh-my-openagent package, the local opencode models cache, and your declared
inventory). The single network dependency is `plutus discover`, which shells out to
`bun x @slkiser/opencode-quota show --json` to fetch your live subscription quota.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [Quick start](#quick-start)
- [Installation](#installation)
- [The five commands](#the-five-commands)
  - [`plutus optimize`](#plutus-optimize)
  - [`plutus discover`](#plutus-discover)
  - [`plutus check-chains`](#plutus-check-chains)
  - [`plutus rollback`](#plutus-rollback)
  - [`plutus challenge`](#plutus-challenge)
- [Configuration](#configuration)
  - [`inventory.yaml`](#inventoryyaml)
  - [`pinned.json` (sidecar)](#pinnedjson-sidecar)
  - [`history.jsonl` (telemetry ledger)](#historyjsonl-telemetry-ledger)
- [How the solver works](#how-the-solver-works)
  - [Data sources](#data-sources)
  - [Quality model: `quality = fit × capability`](#quality-model-quality--fit--capability)
  - [The P5 tiebreak chain](#the-p5-tiebreak-chain)
  - [Forbidden assignments (hard NOT-IN)](#forbidden-assignments-hard-not-in)
  - [Capacity handling: overflow-only, never σ on null](#capacity-handling-overflow-only-never-σ-on-null)
  - [DeepSeek injection (S6)](#deepseek-injection-s6)
  - [Emit shape: `fallback_models` vs `models`](#emit-shape-fallback_models-vs-models)
- [Safety & verification](#safety--verification)
  - [Local schema validation (primary gate)](#local-schema-validation-primary-gate)
  - [Doctor soft-check](#doctor-soft-check)
  - [Atomic writes & backups everywhere](#atomic-writes--backups-everywhere)
  - [Exit codes](#exit-codes)
- [The report (`plutus-report.md`)](#the-report-plutus-reportmd)
- [Development](#development)
  - [Project layout](#project-layout)
  - [Testing](#testing)
  - [Vendored snapshots & drift](#vendored-snapshots--drift)
- [Limitations & roadmap](#limitations--roadmap)
- [License](#license)

---

## Why it exists

oh-my-openagent already resolves models at runtime through its own fallback machinery
(Override → Category default → user `fallback_models` → hardcoded chain → System default).
The problem is *choosing what to put in that config in the first place* — which head model
and which fallback order best fit each slot's prompt, given your **live** subscription
quotas and **live** model availability.

`omo-plutus` is deliberately **not** a router, **not** a quota collector, and **not** a TUI:

- It does not intercept requests or dispatch traffic — oh-my-openagent keeps doing that.
- It does not reimplement provider auth or quota scraping — it shells out to
  [`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota) for
  quota, and reads opencode's own models cache for availability.
- It emits a config file and prints a diff/report. That's the whole output surface:
  the `model` + `variant` head for each slot, and the ordering of the fallback list.

The result: a config that maximizes **fit × capability** per slot while staying inside
your declared capacity windows — and a report that says *why* every model was chosen.

---

## Quick start

```bash
# 1. Install
bun install

# 2. Declare your subscriptions (see Configuration)
#    → ~/.config/omo-plutus/inventory.yaml

# 3. Discover live quota (dry run first)
bun run src/cli/index.ts discover --write

# 4. Solve and emit the config
bun run src/cli/index.ts optimize

# 5. Audit the result
cat ~/.config/opencode/oh-my-opencode.json   # emitted config (deep-merged)
cat ~/.config/opencode/plutus-report.md      # why each slot got its model
```

All five commands are also exposed through the `plutus` bin after `bun link`:

```bash
bun link
plutus optimize --config my-inventory.yaml
```

---

## Installation

Requires **Bun ≥ 1.3** (the CLI is a Bun script; `bun x` is used for subprocess tools).

```bash
git clone https://github.com/gajendravaradhan/omo-configurator.git
cd omo-configurator
bun install
bun link        # optional — exposes `plutus` on your PATH
```

Dependencies (all runtime, no heavy frameworks):

| Package | Purpose |
|---|---|
| `citty` | CLI command/arg parsing |
| `oh-my-openagent` | **Ground truth** — chain extraction + the local JSON schema (pinned, dist-only package) |
| `acorn` | AST-parses the bundled `dist/index.js` to extract model-requirement chains |
| `ajv` + `ajv-formats` | Local JSON Schema validation (the primary verification gate) |
| `yaml` | `inventory.yaml` parse/serialize |

The optional quota data source, [`@slkiser/opencode-quota`](https://www.npmjs.com/package/@slkiser/opencode-quota)
(scoped — the unscoped name is a different, colliding package), is invoked via `bun x` at
runtime; install it with `bun add -d @slkiser/opencode-quota` if you want live quota discovery.

---

## The five commands

### `plutus optimize`

Solve every slot and emit `oh-my-opencode.json` + `plutus-report.md`.

```bash
plutus optimize [OPTIONS]

  -c, --config PATH   Path to inventory.yaml
      --mode MODE     Solve mode (v1: absolute-best; adaptive is a refusing stub)
      --output PATH   oh-my-opencode.json target (default ~/.config/opencode/oh-my-opencode.json)
      --db-path PATH  Override opencode.db path (read-only, for future token-history reads)
      --no-merge      Do not deep-merge into existing config (emit fresh)
```

What it does, in order:

1. **Loads `inventory.yaml`** (validates shape + §7 deletions — see Configuration).
2. **P8 startup check** — verifies the installed oh-my-openagent version matches the
   version the emit-shape decision was probed against (`4.19.4`). Mismatch → **exit 3**.
3. **Extracts chains** from the installed package (acorn AST parse of `dist/index.js`),
   computes the pinned chain SHA.
4. **Loads live availability** from `~/.cache/opencode/models.json` (providers declared in
   inventory are always usable).
5. **Solves** every slot independently: build candidates → hard-forbidden filter →
   optional DeepSeek injection → overflow-only capacity rule → P5 tiebreak sort →
   dedupe → pick primary + fallbacks.
6. **Emits** the config through the deep-merge emitter (validate-first, backup, tmp+rename).
7. **Doctor soft-check** — runs `bun x oh-my-opencode doctor --verbose --json`, records the
   Models check and whether a `system-default` marker appeared (soft: warn, never block).
8. **Appends one telemetry line** to `history.jsonl` (the v2 training input — P3).
9. **Writes `plutus-report.md`** — the full audit surface.

```bash
# Example
plutus optimize --config ~/.config/omo-plutus/inventory.yaml
```

> **`--mode=adaptive` is an honest stub.** v1 refuses with **exit 3**:
> `adaptive mode is not available in v1 … requires open research questions A1-A3`.
> Adaptive rebalancing (live budget coupling, shadow prices, guard daemon) is v2.

### `plutus discover`

Thin wrapper around `bun x @slkiser/opencode-quota show --json` + the models cache.

```bash
plutus discover [OPTIONS]

  -c, --config PATH   Path to inventory.yaml
      --write         Atomically write discovered caps back into inventory.yaml
```

- Prints the live quota snapshot (provider → cap/`null`, window resets) and the models
  availability source.
- **Never silently degrades to zero-capacity data.** If the quota tool's output cannot be
  mapped to the inventory shape, it throws **with the raw output preserved in the error** —
  you see what the tool actually returned, not a guessed parse.
- `status: "unavailable"` from a provider maps to `cap: null` (untrusted/overflow-only),
  never a guessed positive number.
- With `--write`: merge → **validate-before-replace** → advisory lockfile → `.bak.<ts>`
  backup → tmp+rename. Trust of existing providers is never rewritten; new providers are
  added with the conservative `user_declared` trust.

```bash
plutus discover                    # dry run — just print
plutus discover --write            # merge the snapshot into inventory.yaml
```

### `plutus check-chains`

Diff the *currently parsed* chains against the vendored snapshot; warn on drift.

```bash
plutus check-chains
```

- Compares 19 slots' fallback chains (providers/model/variant) against
  `snapshots/chains.json` (normalized — derived `position` fields don't count as drift).
- On drift: prints the delta (up to 50 lines) and **exits 3** with instructions to re-run
  `bun run scripts/vendor-snapshot.ts` after reviewing.
- Also runs the P8 version check — a mismatched omo version is treated as unresolved drift
  → **exit 3**.

### `plutus rollback`

Restore a previously emitted config from its backup — **with validation first**.

```bash
plutus rollback [OPTIONS]

      --list          Just list available backups
      --to TS         Timestamp of the backup to restore (or "latest")
      --output PATH   oh-my-opencode.json target path
```

- Lists `oh-my-opencode.json.bak.<timestamp>` files next to the target.
- Restores `latest` or a specific timestamp.
- **Validates the restored config against the LOCAL schema before replacing.** An invalid
  restore is rejected with **exit 2 and the target untouched** — no orphan writes, ever.
- Atomic restore (tmp+rename), same discipline as the emitter.

```bash
plutus rollback --list --output ~/.config/opencode/oh-my-opencode.json
plutus rollback --to latest --output ~/.config/opencode/oh-my-opencode.json
```

### `plutus challenge`

Pin a challenger model for a slot and scaffold the session-level comparator report
(**v1 stub** — honest about what it can't do).

```bash
plutus challenge --slot SLOT --model MODEL [--sessions N]

      --slot SLOT      Slot to challenge (required)
      --model MODEL    Challenger model id (required)
      --sessions N     Number of sessions to compare (default 3)
```

What the stub **does**:

1. **Pins** the challenger (slot → model) into the same sidecar the emitter uses
   (`~/.config/omo-plutus/pinned.json`). While pinned, `plutus optimize` skips that slot —
   so you can run your own sessions against the challenger without the optimizer stomping
   on it.
2. **Scaffolds the comparator report** (`plutus-challenge.md`) with **session-level**
   outcome metrics only: tokens-to-completion, tool-call count, retry/error count,
   abandonment. **No per-slot / per-tool-call attribution** — that is explicitly v2.
3. **Refuses to fabricate numbers** — sessions are validated and reported as `pending`
   until a real session harness exists (gated on SPIKE-02).

---

## Configuration

All paths resolve lazily (so `XDG_CONFIG_HOME` overrides work in tests). Priority order is
`--config PATH` > `OMO_PLUTUS_CONFIG` env > default.

| Path | Purpose |
|---|---|
| `~/.config/omo-plutus/inventory.yaml` | Declared subscriptions + capacity (default) |
| `~/.config/omo-plutus/pinned.json` | Pinned slots sidecar (skipped by optimize) |
| `~/.config/omo-plutus/history.jsonl` | Append-only telemetry ledger (P3) |
| `~/.config/omo-plutus/.lock` | Advisory lockfile for inventory write-back |
| `~/.config/opencode/oh-my-opencode.json` | Emit target (default) |
| `~/.cache/opencode/models.json` | Live model availability + capability flags |

### `inventory.yaml`

Declares your providers, their billing type, and capacity. Schema:
`schemas/inventory.yaml` (JSON Schema, draft-07, YAML form).

```yaml
version: 1
providers:
  openai:
    cap: 0.8                       # remaining subscription quota 0..1
    window_resets: "2026-08-15T00:00:00Z"
    trust: remote_api              # remote_api | local_estimation | user_declared
  opencode-go:
    cap: 0.9
    window_resets: "2026-08-15T00:00:00Z"
    trust: local_estimation
  deepseek:
    cap: null                      # uncapped / metered → overflow-only (NEVER apply σ to null)
    trust: user_declared
```

Rules (enforced by the loader at **every** nesting level):

- **Trust taxonomy** is exactly `{remote_api, local_estimation, user_declared}`.
- **§7 deletions are forbidden**: `reserve_policy`, `promo`, `subscription_flat`,
  `anthropic_flat` — rejected at the document top level *and* inside every provider block.
  (Claude Pro cannot be used by opencode/omo; the optimizer's input set has no
  subscription-flat Anthropic.)
- `cap` must be a number in `[0, 1]` **or** `null`. `null` = uncapped/metered →
  overflow-only allocation, never a guessed limit.
- **No hardcoded tier limits anywhere.** Capacity comes from `discover` or `user_declared`
  only.

### `pinned.json` (sidecar)

```json
{
  "version": 1,
  "slots": ["oracle"],
  "pinned_challenger": { "oracle": "gpt-5.6-sol" }
}
```

Pinned slots are **skipped by the solver** and **never touched by the merge**. This is the
v1 mechanism for "hands off this slot" (and what `plutus challenge` uses). It is a
**sidecar** — never written into `oh-my-opencode.json` (the schema is
`additionalProperties: false` at three levels; an `x-plutus-pinned` style key would fail
validation).

### `history.jsonl` (telemetry ledger)

One JSONL line appended per `optimize` run (append-only, never rewritten, never
transmitted):

```json
{
  "ts": "2026-08-07T07:06:46.805Z",
  "mode": "absolute-best",
  "chain_sha": "e522d513a08d0a6871129dbf3d9c3a79e4871693997fbf34190c4d3fa3d6b4b5",
  "quota_snapshot_per_provider": { "openai": 0.8, "opencode-go": 0.9, "deepseek": null },
  "assignments": { "sisyphus": { "model": "…", "provider": "…", "quality": 0.8 } },
  "trust_levels": { "openai": "remote_api", "opencode-go": "local_estimation", "deepseek": "user_declared" }
}
```

This is **v2's entire training input** — with it, adaptive mode starts with months of real
history instead of nothing. It costs ~20 LOC now.

---

## How the solver works

### Data sources

| Source | What it gives | Pinned? |
|---|---|---|
| Installed `oh-my-openagent` `dist/index.js` | The 19 slots' fallback chains (`AGENT_MODEL_REQUIREMENTS` / `CATEGORY_MODEL_REQUIREMENTS`) | Yes — sha256 recorded in report & snapshot |
| `~/.cache/opencode/models.json` | Which `(provider, model)` pairs exist + capability flags (reasoning, tool_call, family, pricing) | Read live; snapshot vendored for drift |
| `inventory.yaml` | Declared capacity + trust per provider | — |
| `tiers.json` | Static capability tiers by family (with P6 provenance) | Data-only, no fetcher |
| `@slkiser/opencode-quota` | Live quota snapshot (via `discover`) | — |

**Chain extraction is AST-based, not regex and not `eval`.** The npm package is dist-only;
the constants are declared with `var` inside `dist/index.js` and are **not** exported at top
level (`@oh-my-opencode/model-core` is not on npm). `acorn` parses the bundle, we find the
`VariableDeclarator` initializers, and materialize the object/array literals structurally.

### Quality model: `quality = fit × capability`

A **weighted product with coarse discrete levels** (the α/β exponent form was deleted by the
adversarial review — `quality = fit^α × capability^β` is gone).

- `fit ∈ {1.0 head, 0.8 member, 0.5 family-match-only, 0 forbidden}` — derived from chain
  position (`position 0` = the author's considered head for that slot's prompt).
- `capability ∈ {1.0, 0.7, 0.4}` — from models.json flags + `tiers.json`:
  - both `reasoning` and `tool_call` → 1.0; exactly one → 0.7; neither → 0.4;
  - then **min** with the family's tier from `tiers.json`;
  - **0.9 self-report discount** when the tier entry is `self_reported` (P6).

### The P5 tiebreak chain

The coarse levels make **ties the common case** — so the tiebreak chain is the *real*
decision procedure. Total, deterministic order after `fit × capability`:

1. **Lower projected cost** (metered $; flat/subscription = 0)
2. **Greater remaining quota headroom** on the model's provider
3. **Earlier chain position**
4. **Lexical model id** (guarantees totality — never omitted)

This means the same input always produces the same config.

### Forbidden assignments (hard NOT-IN)

A **separate hard pass applied BEFORE scoring** — never folded into the quality model
(folding it in would make `fit = 0` reachable and let forbidden assignments leak into the
output). This coupling is load-bearing and documented in `src/forbidden.ts` and
`src/solver.ts`.

Rules (verified against omo 4.19.4 chain data):

- **R1**: `hephaestus` must **never** be assigned a DeepSeek model (primary or fallback).
- **R1b**: `hephaestus` must **never** be assigned a MiniMax model.
- **R1c**: `oracle` must **never** be assigned a MiniMax model.
- **R1d**: `explore` / `librarian` must **never** be assigned a Claude Opus model (speed slots).
- **R2 (by construction)**: a model may only be served by a provider listed in its chain
  entry's `providers` array.
- **R3**: a model id that never appears in a slot's chain may not be force-assigned
  (injected DeepSeek is the single sanctioned exception, family-matched).

Two §3.1 plan rows are **deliberately not enforced** because they contradict the live
omo 4.19.4 chains (verified 2026-08-07): `visual-engineering` "not Kimi/GLM/Claude"
(the chain itself ships claude-opus-5, kimi-k3, glm-5.2) and `artistry` "Gemini-required"
(the chain has no Gemini entry). Enforcing either would empty the slot; chain-legality (R2)
governs instead. See `src/forbidden.ts` for the full rationale.

### Capacity handling: overflow-only, never σ on null

- A `cap: null` (untrusted) provider is assigned **only when no trusted candidate exists**
  for the slot — i.e., overflow-only, after trusted windows fill.
- **σ is never applied to `null`.** (`null × 0.5 = null` was the single most important
  finding of the adversarial review — applying a safety factor to an unknown capacity is
  anti-conservative and would concentrate load on the least-trusted provider.)
- **S3b degenerate case (P1)**: when *every* declared cap is `null` (trusted set empty),
  "overflow-only" is undefined → pure `fit × capability` argmax with no capacity term.
  Per-assignment untrusted markers are **suppressed** — the report emits **exactly one**
  banner:

  > *No provider has verified capacity. Assignments are quality-optimal only; budget
  > constraints are NOT enforced.*

### DeepSeek injection (S6)

DeepSeek is not in omo's default chains — it must be injected. For **GPT-family legal
slots** (`oracle`, `deep`, `ultrabrain`, `prometheus`) whose chain carries a `gpt-*` model:

- Available DeepSeek models are injected into the **fallback list only** (fit 0.5,
  `injected` flag), positioned **after the last `gpt-*` entry and before the first
  `minimax-*` entry** — matching the documented `DeepSeek ≻≻ MiniMax` ordering.
- **`hephaestus` never** — hard-blocked by forbidden R1 and excluded from the legal set.
- The primary is always a real chain candidate (injected are fallback-only).

### Emit shape: `fallback_models` vs `models`

Verified by schema inspection (not assumed):

- **Agents** emit `model` + `fallback_models` — the schema has **no `models` key** for
  agents (`additionalProperties: false`).
- **Categories** emit `model` + `models` (non-deprecated; schema has both).
- Fallback lists are capped at **5 entries**.

---

## Safety & verification

### Local schema validation (primary gate)

- Validation uses the **locally installed** schema
  (`require.resolve("oh-my-openagent/schema.json")` → `dist/oh-my-opencode.schema.json`),
  not an unpinned `dev`-branch URL. Version-locked by the package.
- `$id` + sha256 content hash are recorded in every report.
- **Validate-before-replace everywhere**: an invalid document never clobbers the target and
  never creates an orphan backup.

### Doctor soft-check

- Runs `bun x oh-my-opencode doctor --verbose --json`, parses the `Models` check, and
  empirically verifies the `system-default` marker semantics (verified 2026-08-07: the
  marker is **absent** when all slots carry explicit models).
- **Soft in v1**: doctor anomalies are recorded for the report and logged — they never
  block the optimize flow. Schema validation is the primary gate.

### Atomic writes & backups everywhere

Emitter, `discover --write`, and `rollback` all follow the same discipline:

1. Validate the *new* content first.
2. Advisory lockfile (`~/.config/omo-plutus/.lock`) for concurrent writers.
3. Backup the pre-existing target to `.bak.<timestamp>`.
4. tmp+rename into place (never a partial file).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime error |
| `2` | Validation failure (schema, inventory, restore-rejected) |
| `3` | Spike-unresolved / omo-version-mismatch / chain drift |

---

## The report (`plutus-report.md`)

Written next to the emitted config on every `optimize` run. Headed by the verbatim v1
boundary statement, then:

- **Assignments table** — slot, kind, primary model, provider, fit, capability, quality,
  projected cost, trusted, binding constraint.
- **Rationale** — why each primary won (quality score + binding constraint).
- **Assumptions & trust levels** — inventory providers, per-provider trust, cost proxy
  caveat, the NAS opencode.db caveat (token history not read in v1), mode, pinned chain
  SHA, schema `$id`, omo version probed (P8), emit-shape record, P6 stale-tier flags.
- **Doctor soft-check** section — the Models check + system-default marker observation.

> The report is as important as the config. A recommendation you can't audit is worthless.

---

## Development

### Project layout

```
src/
  cli/index.ts        citty CLI entrypoint (dispatch via runCommand, not runMain)
  commands.ts         command registry shims
  commands/
    discover.ts       → src/discover.ts
    check-chains.ts   drift detection + P8 version check
    rollback.ts       validated restore
    challenge.ts      → src/challenge.ts
  config.ts           lazy path resolution (inventory, pinned, ledger, lock, targets)
  types.ts            core domain types + EXIT codes
  chain.ts            acorn AST chain extraction + pinned SHA + P8 version assert
  availability.ts     models.json availability + capability metadata
  inventory.ts        inventory loader (shape + §7 deletions)
  discover.ts         quota wrapper + atomic write-back
  quality.ts          fit/capability + P5 comparator + P6 tiers provenance
  forbidden.ts        hard NOT-IN rules (R1/R2/R3)
  solver.ts           per-slot argmax + overflow-only + S6 injection
  emitter.ts          deep-merge emitter (validate-first, backup, tmp+rename)
  validate.ts         local-schema validation (primary gate) + schemaInfo
  verify.ts           doctor soft-check
  ledger.ts           append-only telemetry (P3)
  report.ts           plutus-report.md writer
  errors.ts           PlutusError (carries exit code)
  challenge.ts        W6.1 stub (pin + comparator scaffold)
schemas/inventory.yaml   canonical inventory JSON Schema
snapshots/chains.json    vendored chain snapshot (drift baseline)
scripts/vendor-snapshot.ts  regenerate the snapshot
spikes/SPIKE-06.md       Go request-tiered accounting finding (UNVERIFIED, locked decision)
tiers.json               static capability tiers with P6 provenance
test/                    10 test files, 54 tests, 753 assertions
```

### Testing

```bash
bun test              # 54 tests across 10 files (753 assertions)
bun run tsc --noEmit  # typecheck (strict)
```

Test files: `chain`, `check-chains`, `discover`, `emitter`, `inventory`, `ledger`,
`optimize`, `rollback`, `solver`, `stubs`. Fixtures live in `test/fixtures/` (a small
hermetic `models.json` + `inventory.yaml`, plus `w2/` variants for solver scenarios).

The scenario contract covered:

- **S1** happy path — `optimize` exits 0, emits schema-valid config + backup + report
- **S2** property — forbidden assignments unreachable; deterministic output; P5 tiebreak
  exercised (not merely stable sort)
- **S3** edge — `cap: null` provider → overflow-only allocation + untrusted marker
- **S3b** edge — all-null inventory → exactly one banner, quality-only, exit 0
- **S4** edge — merge preserves user keys, skips pinned slots, replaces only owned keys
- **S5** regression — illegal key → schema validation fails with exit 2, target untouched
- **S6** feature — DeepSeek injected after GPT, before MiniMax, never `hephaestus`

### Vendored snapshots & drift

```bash
bun run scripts/vendor-snapshot.ts   # regenerate snapshots/chains.json from the installed package
plutus check-chains                   # warn on drift, exit 3 on unresolved drift
```

The pinned SHA (sha256 of `dist/index.js`) is your audit trail — when omo's chains change,
`check-chains` tells you before your recommendations go stale.

---

## Limitations & roadmap

**v1 scope (by design, per the adversarial review):**

- **No budget enforcement.** v1 emits quality-optimal legal assignments and reports
  projected consumption. Live budget coupling, shadow prices, and adaptive rebalancing are
  **v2**, gated on SPIKE-02 (per-agent attribution) and SPIKE-06 (Go accounting).
- **Go (opencode-go) capacity is UNVERIFIED** — see `spikes/SPIKE-06.md`. Until a real
  billing source exists, Go is treated as overflow-only + 1× over-estimate + a loud warning.
- **`plutus challenge` is a stub** — it pins the challenger and scaffolds the comparator,
  but real session runs need the v2 session harness (SPIKE-02).
- **`--mode=adaptive` refuses** (exit 3) until A1–A3 research questions are resolved.
- **LOC note:** ~1,600 code lines vs the 1,560 hard stop — every over-budget line maps to a
  required deliverable or patch surface (documented deviation, no slop).
- **Per-slot attribution** of tokens (which agent consumed what) is not attempted — the
  ledger records per-slot *assignments* + per-provider *quota snapshots*, not per-slot
  consumption.

**Roadmap (v2):** live budget coupling via the ledger's accumulated history, adaptive
rebalancing + downgrade patches, the real challenger session harness, Go tier accounting
once SPIKE-06 is re-opened with real billing data, and per-slot token attribution when
`opencode.db` exposes a session→agent mapping.

---

## License

MIT — Copyright (c) 2026 Gajendra Varadhan. See [LICENSE](LICENSE).
