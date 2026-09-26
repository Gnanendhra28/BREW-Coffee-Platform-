import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const assetsDir = path.resolve(process.cwd(), "public/assets");

function getAllPngFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllPngFiles(fullPath));
    } else if (file.toLowerCase().endsWith(".png")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function runOptimization() {
  console.log("=== BREW ASSET OPTIMIZATION: PNG TO WEBP CONVERSION ===");
  console.log(`Scanning: ${assetsDir}`);

  const pngFiles = getAllPngFiles(assetsDir);
  console.log(`Found ${pngFiles.length} PNG assets to optimize.\n`);

  let totalOriginalBytes = 0;
  let totalOptimizedBytes = 0;

  for (const pngPath of pngFiles) {
    const origStat = fs.statSync(pngPath);
    totalOriginalBytes += origStat.size;

    const webpPath = pngPath.replace(/\.png$/i, ".webp");
    const relativePng = path.relative(process.cwd(), pngPath);
    const relativeWebp = path.relative(process.cwd(), webpPath);

    try {
      // Execute cwebp with high quality and alpha transparency compression
      const cmd = `cwebp -q 82 -alpha_q 85 -m 4 "${pngPath}" -o "${webpPath}"`;
      execSync(cmd, { stdio: "pipe" });

      const webpStat = fs.statSync(webpPath);
      totalOptimizedBytes += webpStat.size;

      const origKb = (origStat.size / 1024).toFixed(1);
      const webpKb = (webpStat.size / 1024).toFixed(1);
      const reduction = (((origStat.size - webpStat.size) / origStat.size) * 100).toFixed(1);

      console.log(
        `✓ [${reduction}% smaller] ${relativePng} (${origKb} KB) -> ${path.basename(relativeWebp)} (${webpKb} KB)`
      );
    } catch (err) {
      console.error(`Failed to convert ${pngPath}:`, err.message);
    }
  }

  const origMb = (totalOriginalBytes / (1024 * 1024)).toFixed(2);
  const optMb = (totalOptimizedBytes / (1024 * 1024)).toFixed(2);
  const totalReduction = (
    ((totalOriginalBytes - totalOptimizedBytes) / totalOriginalBytes) *
    100
  ).toFixed(1);

  console.log("\n=======================================================");
  console.log(`📦 TOTAL ORIGINAL PNG SIZE : ${origMb} MB`);
  console.log(`⚡ TOTAL OPTIMIZED WEBP SIZE: ${optMb} MB`);
  console.log(`🚀 OVERALL BANDWIDTH SAVINGS: ${totalReduction}% REDUCTION`);
  console.log("=======================================================\n");
}

runOptimization();
