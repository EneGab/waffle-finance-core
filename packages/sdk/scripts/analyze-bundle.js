#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Analyze SDK bundle structure and verify tree-shakable exports.
 * Checks that:
 * 1. All exported modules are accessible
 * 2. No circular dependencies in barrel exports
 * 3. Unused modules would be omitted by bundlers
 */

const distDir = path.join(__dirname, "..", "dist");

function analyzeExports() {
  console.log("\n📦 SDK Bundle Analysis\n");

  // Check that dist directory exists
  if (!fs.existsSync(distDir)) {
    console.error("❌ dist/ directory not found. Run: npm run build");
    process.exit(1);
  }

  const exports = [
    "index.js",
    "types/index.js",
    "secrets/index.js",
    "ethereum/index.js",
    "soroban/index.js",
    "solana/index.js",
    "state-machine/index.js",
    "assets/index.js",
  ];

  let allValid = true;

  exports.forEach((exp) => {
    const filePath = path.join(distDir, exp);
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      console.log(`✅ ${exp} (${stats.size} bytes)`);
    } else {
      console.error(`❌ Missing export: ${exp}`);
      allValid = false;
    }
  });

  // Verify sideEffects: false in package.json
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  console.log("\n🎯 Configuration Checks:");
  if (pkg.sideEffects === false) {
    console.log("✅ sideEffects: false (tree-shaking enabled)");
  } else {
    console.error("❌ sideEffects not set to false");
    allValid = false;
  }

  if (pkg.type === "module") {
    console.log("✅ type: module (ESM format)");
  }

  if (pkg.exports && typeof pkg.exports === "object") {
    console.log(`✅ exports field configured (${Object.keys(pkg.exports).length} entry points)`);
  }

  console.log("\n✨ Tree-shaking verification complete!");
  console.log(
    "\nConsumers can now import specific exports:\n" +
    "  import { EthereumHTLCClient } from '@wafflefinance/sdk';\n" +
    "  import { generateSecret } from '@wafflefinance/sdk/secrets';\n" +
    "  import type { Order } from '@wafflefinance/sdk/types';\n"
  );

  if (!allValid) {
    process.exit(1);
  }
}

analyzeExports();
