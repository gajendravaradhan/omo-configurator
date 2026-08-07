// W3.3 — discover write-back property tests (RED on empty impl).
// Contract (bundle §1.9 + W3.4): write-back is tmp+rename atomic, guarded by an advisory lockfile,
// backs up the pre-existing inventory to .bak.<timestamp>, and VALIDATES the new content BEFORE
// replacing (validate-before-replace — the target is never clobbered with an invalid inventory).
// parseQuotaOutput NEVER silently degrades to zero-capacity data — unmappable output throws with
// the raw output preserved in the error.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuotaOutput, mergeQuota, serializeInventory, writeInventoryAtomic, type QuotaSnapshot } from "../src/discover.ts";
import { parseInventory } from "../src/inventory.ts";
import { PlutusError } from "../src/errors.ts";

const VALID_INVENTORY = `version: 1
providers:
  openai:
    cap: 0.8
    window_resets: "2026-08-15T00:00:00Z"
    trust: remote_api
  deepseek:
    cap: null
    trust: user_declared
`;

let dir: string;
let invPath: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plutus-disc-"));
  invPath = join(dir, "inventory.yaml");
  lockPath = join(dir, ".lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---- parseQuotaOutput -----------------------------------------------------------

test("W3.3: parseQuotaOutput maps the documented shape (providers → cap/window_resets)", () => {
  const raw = JSON.stringify({
    generated: "2026-08-07T00:00:00Z",
    providers: {
      openai: { cap: 0.42, window_resets: "2026-08-15T00:00:00Z" },
      anthropic: { quota: 0.0, window_resets: "2026-08-15T00:00:00Z" },
      deepseek: { cap: null },
    },
  });
  const q = parseQuotaOutput(raw);
  expect(q.providers.openai!.cap).toBe(0.42);
  expect(q.providers.anthropic!.cap).toBe(0.0); // quota alias normalized to cap
  expect(q.providers.deepseek!.cap).toBeNull();
  expect(q.raw).toBe(raw);
});

test("W3.3: parseQuotaOutput handles the VERIFIED show --json shape — unavailable → null cap (never guessed)", () => {
  const raw = JSON.stringify({
    version: 2,
    exportedAt: 1786085894,
    fromCache: true,
    providers: {
      anthropic: { status: "unavailable" },
      openai: { status: "ok", cap: 0.55, sources: ["cache"] },
    },
  });
  const q = parseQuotaOutput(raw);
  expect(q.providers.anthropic!.cap).toBeNull(); // no verified capacity → untrusted, NOT a guess
  expect(q.providers.openai!.cap).toBe(0.55);
});

test("W3.3: parseQuotaOutput NEVER silently degrades — unmappable output throws with raw preserved", () => {
  const raw = "provider=openai quota=0.5\nprovider=deepseek quota=null\n";
  try {
    parseQuotaOutput(raw);
    expect.unreachable("expected unmappable quota output to throw");
  } catch (e: unknown) {
    expect(e).toBeInstanceOf(PlutusError);
    expect((e as PlutusError).message).toContain("quota");
    expect((e as PlutusError).message).toContain("openai"); // raw output surfaced, not swallowed
  }
  expect(() => parseQuotaOutput("not json at all")).toThrow();
});

// ---- mergeQuota -----------------------------------------------------------------

test("W3.3: mergeQuota updates caps, preserves trust, keeps untouched providers, adds new as user_declared", () => {
  const inv = parseInventory(VALID_INVENTORY);
  const quota: QuotaSnapshot = {
    raw: "",
    providers: {
      openai: { cap: 0.31, window_resets: "2026-08-20T00:00:00Z" },
      vercel: { cap: 0.9 }, // new provider — not declared before
    },
  };
  const merged = mergeQuota(inv, quota);
  expect(merged.providers.openai!.cap).toBe(0.31);
  expect(merged.providers.openai!.trust).toBe("remote_api"); // preserved
  expect(merged.providers.openai!.windowResets).toBe("2026-08-20T00:00:00Z");
  expect(merged.providers.deepseek!.cap).toBeNull(); // untouched provider keeps declared value
  expect(merged.providers.vercel!.cap).toBe(0.9);
  expect(merged.providers.vercel!.trust).toBe("user_declared"); // conservative default
});

test("W3.3: serializeInventory emits canonical snake_case YAML that round-trips through parseInventory", () => {
  const inv = parseInventory(VALID_INVENTORY);
  const quota: QuotaSnapshot = { raw: "", providers: { openai: { cap: 0.31, window_resets: "2026-08-20T00:00:00Z" } } };
  const merged = mergeQuota(inv, quota);
  const yaml = serializeInventory(merged);
  expect(yaml).not.toContain("windowResets"); // canonical snake_case only
  expect(yaml).toContain("window_resets:");
  expect(yaml).not.toContain("provider: openai"); // no self-referential key
  const reparsed = parseInventory(yaml);
  expect(reparsed.providers.openai!.cap).toBe(0.31);
  expect(reparsed.providers.openai!.windowResets).toBe("2026-08-20T00:00:00Z");
  expect(reparsed.providers.deepseek!.cap).toBeNull();
});

// ---- writeInventoryAtomic --------------------------------------------------------

test("W3.3: writeInventoryAtomic writes tmp+rename atomically and backs up the pre-existing file", () => {
  writeFileSync(invPath, "old-content\n");
  const { backupPath } = writeInventoryAtomic(invPath, VALID_INVENTORY, lockPath);
  expect(readFileSync(invPath, "utf8")).toBe(VALID_INVENTORY);
  expect(backupPath).not.toBeNull();
  expect(existsSync(backupPath!)).toBe(true);
  expect(readFileSync(backupPath!, "utf8")).toBe("old-content\n");
  // No tmp litter.
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp."));
  expect(leftovers).toEqual([]);
});

test("W3.3: validate-before-replace — invalid content never clobbers the target", () => {
  writeFileSync(invPath, "original\n");
  const before = readdirSync(dir).sort();
  expect(() => writeInventoryAtomic(invPath, "version: 1\nproviders: [not-a-mapping]\n", lockPath)).toThrow(PlutusError);
  expect(readFileSync(invPath, "utf8")).toBe("original\n"); // untouched
  const after = readdirSync(dir).sort();
  expect(after).toEqual(before); // no backup, no tmp for a rejected write
});

test("W3.3: advisory lockfile blocks concurrent writers and is released after", () => {
  writeFileSync(invPath, "original\n");
  writeFileSync(lockPath, String(process.pid));
  expect(() => writeInventoryAtomic(invPath, VALID_INVENTORY, lockPath)).toThrow(/lock/i);
  expect(readFileSync(invPath, "utf8")).toBe("original\n"); // not clobbered while locked

  rmSync(lockPath); // writer finished → lock released
  const { backupPath } = writeInventoryAtomic(invPath, VALID_INVENTORY, lockPath);
  expect(readFileSync(invPath, "utf8")).toBe(VALID_INVENTORY);
  expect(backupPath).not.toBeNull();
  expect(existsSync(lockPath)).toBe(false); // lock cleaned up on success
});
