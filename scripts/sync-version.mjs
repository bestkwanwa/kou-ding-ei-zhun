import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Read version from core/version.ts as single source of truth
const versionFile = readFileSync(join(ROOT, "packages/core/src/version.ts"), "utf-8");
const match = versionFile.match(/export const version = "([^"]+)"/);
if (!match) {
  console.error("Cannot find version in packages/core/src/version.ts");
  process.exit(1);
}
const version = match[1];

function findPackageJsons(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findPackageJsons(full));
    } else if (entry === "package.json") {
      results.push(full);
    }
  }
  return results;
}

const files = findPackageJsons(ROOT);
let changed = 0;

for (const file of files) {
  const content = readFileSync(file, "utf-8");
  const updated = content.replace(
    /"version": "[^"]+"/,
    `"version": "${version}"`
  );
  if (updated !== content) {
    writeFileSync(file, updated);
    const relative = file.replace(ROOT + "/", "");
    console.log(`updated: ${relative} → ${version}`);
    changed++;
  }
}

if (changed === 0) {
  console.log(`all package.json files already at version ${version}`);
}
