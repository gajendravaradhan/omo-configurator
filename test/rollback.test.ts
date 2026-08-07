// W4.5 (P7) — rollback tests: list backups, restore validated, invalid restore → exit 2 with NO
// file replaced. RED on empty impl (rollback.ts is a stub).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBackups, rollback } from "../src/commands/rollback.ts";
import { PlutusError } from "../src/errors.ts";
import { EXIT } from "../src/types.ts";

let dir: string;
let cfgPath: string;

const GIT_MASTER = { commit_footer: true, include_co_authored_by: true, git_env_prefix: "GIT_MASTER=1" };
const VALID_V1 = JSON.stringify({ git_master: GIT_MASTER, agents: { oracle: { model: "gpt-5.6-sol" } } }, null, 2);
const VALID_V2 = JSON.stringify({ git_master: GIT_MASTER, agents: { oracle: { model: "claude-opus-5" } } }, null, 2);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plutus-rb-"));
  cfgPath = join(dir, "oh-my-opencode.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeBackup(ts: string, content: string): string {
  const p = `${cfgPath}.bak.${ts}`;
  writeFileSync(p, content);
  return p;
}

test("W4.5: listBackups returns backups sorted ascending; empty when none", () => {
  expect(listBackups(cfgPath)).toEqual([]);
  makeBackup("2026-08-07T00-00-00-000Z", VALID_V1);
  makeBackup("2026-08-07T01-00-00-000Z", VALID_V2);
  const backups = listBackups(cfgPath);
  expect(backups.length).toBe(2);
  expect(backups[0]).toContain("2026-08-07T00-00-00-000Z");
  expect(backups[1]).toContain("2026-08-07T01-00-00-000Z");
});

test("W4.5: rollback --to <ts> restores the selected backup atomically", async () => {
  writeFileSync(cfgPath, "current\n");
  makeBackup("2026-08-07T00-00-00-000Z", VALID_V1);
  await rollback({ list: false, to: "2026-08-07T00-00-00-000Z", outputPath: cfgPath });
  expect(JSON.parse(readFileSync(cfgPath, "utf8")).agents.oracle.model).toBe("gpt-5.6-sol");
});

test("W4.5: rollback --to latest restores the most recent backup", async () => {
  writeFileSync(cfgPath, "current\n");
  makeBackup("2026-08-07T00-00-00-000Z", VALID_V1);
  makeBackup("2026-08-07T01-00-00-000Z", VALID_V2);
  await rollback({ list: false, to: "latest", outputPath: cfgPath });
  expect(JSON.parse(readFileSync(cfgPath, "utf8")).agents.oracle.model).toBe("claude-opus-5");
});

test("W4.5: invalid restore is rejected with exit 2 and NO file is replaced", async () => {
  writeFileSync(cfgPath, "current-content\n");
  const badBackup = makeBackup("2026-08-07T00-00-00-000Z", JSON.stringify({ git_master: { commit_footer: true }, illegal_key: true }, null, 2));
  try {
    await rollback({ list: false, to: "2026-08-07T00-00-00-000Z", outputPath: cfgPath });
    expect.unreachable("invalid restore must be rejected");
  } catch (e: unknown) {
    expect((e as PlutusError).exitCode).toBe(EXIT.VALIDATION);
  }
  expect(readFileSync(cfgPath, "utf8")).toBe("current-content\n"); // untouched
  expect(existsSync(badBackup)).toBe(true); // backup preserved for the operator
});

test("W4.5: rollback with no matching backup fails loudly (exit 1, not silent)", async () => {
  try {
    await rollback({ list: false, to: "2026-08-07T00-00-00-000Z", outputPath: cfgPath });
    expect.unreachable("missing backup must throw");
  } catch (e: unknown) {
    expect((e as PlutusError).exitCode).toBe(EXIT.RUNTIME);
    expect((e as PlutusError).message).toContain("backup");
  }
});
