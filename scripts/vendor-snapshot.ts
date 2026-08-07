// W1.3: vendor the current parsed chains into snapshots/chains.json.
import { writeFileSync } from "node:fs";
import { extractChains, pinnedChainSha, installedOmoVersion, omoDistPath } from "../src/chain.ts";
const chains = extractChains();
const out = {
  generated: new Date().toISOString(),
  omo_version: installedOmoVersion(),
  dist_path: omoDistPath(),
  pinned_sha: pinnedChainSha(),
  slots: chains.map((c) => ({
    kind: c.kind,
    name: c.name,
    fallbackChain: c.fallbackChain.map((e) => ({ providers: e.providers, model: e.model, ...(e.variant ? { variant: e.variant } : {}) })),
  })),
};
writeFileSync("snapshots/chains.json", JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("snapshot written:", out.slots.length, "slots, sha", out.pinned_sha.slice(0, 12));