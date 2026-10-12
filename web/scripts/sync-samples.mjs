// Copies ../images/ -> public/samples/ + manifest.json (runs as prebuild).
import { readdirSync, copyFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "images");
const destDir = join(here, "..", "public", "samples");
const exts = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);

mkdirSync(destDir, { recursive: true });

const files = readdirSync(srcDir)
  .filter((f) => exts.has(extname(f).toLowerCase()))
  .filter((f) => {
    try {
      return statSync(join(srcDir, f)).isFile();
    } catch {
      return false;
    }
  })
  .sort();

for (const f of files) {
  copyFileSync(join(srcDir, f), join(destDir, f));
}

const manifest = files.map((f) => ({
  file: f,
  label: f.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
}));
writeFileSync(join(destDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`samples: ${files.length} files -> public/samples/ + manifest.json`);
