import { parse, stringify } from "yaml";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
const path = process.argv[2] ?? "inventory.yaml";
const KEEP = ["openai", "opencode-go", "deepseek"];
const doc = parse(readFileSync(path, "utf8")) as any;
const all = doc.providers ?? {};
console.log("Providers found:", Object.keys(all).length);
const kept: Record<string, unknown> = {};
for (const id of KEEP) {
  const p = all[id];
  if (p) { kept[id] = p; console.log(`  KEEP ${id.padEnd(14)} cap=${p.cap} window_tokens=${p.window_tokens ?? "null"} trust=${p.trust}`); }
  else { kept[id] = { cap: null, window_tokens: null, trust: "user_declared" }; console.log(`  ADD  ${id.padEnd(14)} (was missing)`); }
}
const dropped = Object.keys(all).filter((k) => !KEEP.includes(k));
console.log(`Dropping ${dropped.length} unused provider(s)`);
doc.providers = kept;
doc.demand = doc.demand ?? { default_tokens: 50000, sigma: 0.8, observed_span_hours: 168 };
console.log("demand block:", JSON.stringify(doc.demand));
copyFileSync(path, `${path}.prebrune.bak`);
writeFileSync(path, stringify(doc), "utf8");
console.log(`\nWrote pruned ${path} (backup: ${path}.prebrune.bak)`);
