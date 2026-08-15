// W4.5 (P7) — rollback: list .bak.<timestamp> backups and restore a selected one, validating the
// restored config against the LOCAL schema BEFORE replacing (reject invalid restore with exit 2,
// no file replaced). Same atomic discipline as the emitter (tmp+rename).
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { validateConfig } from "../validate.ts";
import { PlutusError } from "../errors.ts";
import { EXIT } from "../types.ts";

export interface RollbackArgs {
  list: boolean; to?: string; outputPath: string;
}

/** Backups for the target, sorted ascending by timestamp: <target>.bak.<ts>. */
export function listBackups(outputPath: string): string[] {
  const dir = dirname(outputPath); if (!existsSync(dir)) return []; const prefix = `${basename(outputPath)}.bak.`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .sort()
    .map((f) => join(dir, f));
}

/** Restore the selected backup (or the most recent with `latest`) — validated BEFORE replacing. */
export async function rollback(args: RollbackArgs): Promise<void> {
  const backups = listBackups(args.outputPath);

  if (args.list) {
    if (!backups.length) { console.log("[rollback] no backups found"); return; }
    console.log(`[rollback] ${backups.length} backup(s) for ${args.outputPath}:`);
    for (const b of backups) console.log(`  ${basename(b)}`);
    return;
  }

  if (!args.to) {
    throw new PlutusError(`rollback requires --to <timestamp> or --to latest (or --list)`, EXIT.RUNTIME);
  }

  let target: string | null = null;
  if (args.to === "latest") {
    target = backups.length > 0 ? backups[backups.length - 1]! : null;
  } else {
    target = backups.find((b) => basename(b).includes(`.bak.${args.to}`)) ?? null;
  }
  if (!target) throw new PlutusError(`no backup matches "${args.to}" for ${args.outputPath} (found ${backups.length} backup(s))`, EXIT.RUNTIME);

  const restored = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>; const v = validateConfig(restored);
  if (!v.valid) throw new PlutusError(`refusing to restore ${basename(target)}: config fails LOCAL schema validation (exit 2): ${v.errors.join("; ")}`, EXIT.VALIDATION);

  // Atomic restore (tmp+rename); the invalid case above never reaches the target.
  const tmp = `${args.outputPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(restored, null, 2) + "\n", "utf8");
  renameSync(tmp, args.outputPath);
  console.log(`[rollback] restored ${basename(target)} → ${args.outputPath}`);
}
