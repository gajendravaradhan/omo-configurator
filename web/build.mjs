// Build the web app with Bun's native bundler (zero extra deps beyond react).
// Output: web/dist/index.html + web/dist/index.js
import { build } from "bun";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

const watch = process.argv.includes("--watch");

const result = await build({
  entrypoints: [join(root, "src", "index.tsx")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
});

if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}

writeFileSync(
  join(outDir, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>omo-plutus — model allocation command center</title>
<link rel="stylesheet" href="/index.css" />
</head>
<body>
<div id="root"></div>
<script type="module" src="/index.js"></script>
</body>
</html>`,
);

writeFileSync(
  join(outDir, "index.css"),
  `@import url("/design.css");`,
);

// DESIGN.md token layer — copied as-is so /design.css is served by the server's static handler.
copyFileSync(join(root, "src", "design.css"), join(outDir, "design.css"));

console.log(`[plutus-web] built web/dist (${watch ? "watch" : "production"})`);
