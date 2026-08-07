// W6.1 — `plutus challenge` ~50-LOC emitter+comparator stub.
//
// Honest scope (bundle §5 / W6.1): v1 cannot run real challenger sessions. What this stub DOES:
//   1. Pins the challenger model for the slot via the SAME sidecar the emitter uses
//      (~/.config/omo-plutus/pinned.json — the emitter pin machinery). While pinned, `plutus
//      optimize` skips the slot, so the user can run their own sessions against the challenger
//      without the optimizer stomping on it.
//   2. Produces the comparator report scaffold with SESSION-LEVEL outcome metrics:
//      tokens-to-completion, tool-call count, retry/error count, abandonment. NO per-slot
//      attribution (metrics are per-session; attributing to individual tool calls is v2).
//   3. Refuses to fabricate numbers — sessions=N is validated and reported as "pending" until a
//      real session harness exists (gated on SPIKE-02 live budget coupling / session telemetry).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pinnedSidecarPath } from "./config.ts";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

export interface ChallengeArgs {
  slot: string;
  model: string;
  sessions: number;
}

/** Session-level outcome metric — NEVER attributed per-slot / per-tool-call in v1. */
export interface SessionOutcome {
  session: number;
  tokens_to_completion: number | null; // null = not measurable by the v1 stub
  tool_calls: number | null;
  retries_errors: number | null;
  abandoned: boolean | null;
}

/** Pin the challenger (slot → model) into the sidecar. Returns the updated pinned slot list. */
export function pinChallenger(slot: string, model: string, sidecarPath: string = pinnedSidecarPath()): string[] {
  const doc = existsSync(sidecarPath)
    ? (JSON.parse(readFileSync(sidecarPath, "utf8")) as { slots?: unknown })
    : {};
  const slots = new Set<string>((Array.isArray(doc.slots) ? doc.slots : []).filter((s): s is string => typeof s === "string"));
  slots.add(slot);
  const out = [...slots].sort();
  mkdirSync(dirname(sidecarPath), { recursive: true });
  writeFileSync(sidecarPath, JSON.stringify({ version: 1, slots: out, pinned_challenger: { [slot]: model } }, null, 2) + "\n", "utf8");
  return out;
}

/** Build the comparator report scaffold (session-level metrics only). */
export function renderComparator(slot: string, model: string, sessions: number, pinned: string[]): string {
  const outcomes: SessionOutcome[] = Array.from({ length: sessions }, (_, i) => ({
    session: i + 1,
    tokens_to_completion: null,
    tool_calls: null,
    retries_errors: null,
    abandoned: null,
  }));
  const lines: string[] = [];
  lines.push("# plutus-challenge (W6.1 stub)", "");
  lines.push(`- Challenged slot: **${slot}**`);
  lines.push(`- Challenger model: **${model}**`);
  lines.push(`- Requested sessions: ${sessions}`);
  lines.push(`- Slot pinned: ${pinned.includes(slot) ? "yes" : "no"}`);
  lines.push("");
  lines.push("## Session-level outcomes (NO per-slot attribution)", "");
  lines.push("| session | tokens-to-completion | tool-call count | retries/errors | abandoned |");
  lines.push("|---|---|---|---|---|");
  for (const o of outcomes) {
    lines.push(`| ${o.session} | ${o.tokens_to_completion ?? "pending"} | ${o.tool_calls ?? "pending"} | ${o.retries_errors ?? "pending"} | ${o.abandoned ?? "pending"} |`);
  }
  lines.push("");
  lines.push("> v1 stub honesty: real session runs require the v2 session harness (gated on SPIKE-02).");
  lines.push("> Metrics are session-level by design — attributing outcomes to individual tool calls or");
  lines.push("> slots is NOT attempted in v1.");
  return lines.join("\n");
}

export async function challenge(args: ChallengeArgs): Promise<void> {
  if (args.sessions < 1 || !Number.isInteger(args.sessions)) {
    throw new PlutusError(`challenge sessions must be a positive integer (got ${args.sessions})`, EXIT.VALIDATION);
  }
  const pinned = pinChallenger(args.slot, args.model);
  const report = renderComparator(args.slot, args.model, args.sessions, pinned);

  const reportPath = join(process.cwd(), "plutus-challenge.md");
  writeFileSync(reportPath, report, "utf8");

  console.log(`[challenge] pinned ${args.slot} → ${args.model} (slot will be skipped by optimize)`);
  console.log(`[challenge] comparator report (stub): ${reportPath}`);
  console.log(`[challenge] ${args.sessions} session(s) requested — metrics pending the v2 session harness (SPIKE-02)`);
}
