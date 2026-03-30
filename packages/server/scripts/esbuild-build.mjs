#!/usr/bin/env node
/**
 * Fast esbuild-based build script for @getpaseo/server
 * Transpiles TypeScript to JavaScript (30-50x faster than tsc)
 * Run tsc --noEmit separately for type checking
 */

import * as esbuild from 'esbuild';
import { mkdirSync, copyFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Get all TypeScript files recursively
function getAllTsFiles(dir, files = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (!entry.includes('node_modules') && !entry.includes('dist') && !entry.includes('test-utils') && !entry.includes('daemon-e2e')) {
        getAllTsFiles(fullPath, files);
      }
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.e2e.ts') && !entry.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

async function build() {
  console.log('Building with esbuild...');
  const startTime = Date.now();

  try {
    // Clean dist
    const distDir = join(rootDir, 'dist', 'server');
    if (existsSync(distDir)) {
      rmSync(distDir, { recursive: true, force: true });
    }
    mkdirSync(distDir, { recursive: true });

    // Get all TS files
    const srcDir = join(rootDir, 'src');
    const tsFiles = getAllTsFiles(srcDir);
    console.log(`Found ${tsFiles.length} TypeScript files`);

    // Build each file
    let successCount = 0;
    let errorCount = 0;

    for (const file of tsFiles) {
      const relPath = relative(srcDir, file);
      const outPath = join(distDir, relPath.replace(/\.tsx?$/, '.js'));
      const outDir = dirname(outPath);

      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      try {
        await esbuild.build({
          entryPoints: [file],
          outfile: outPath,
          platform: 'node',
          target: 'es2020',
          format: 'esm',
          sourcemap: true,
          sourcesContent: false,
          logLevel: 'error',
        });
        successCount++;
      } catch (err) {
        console.error(`Failed: ${relPath}`);
        console.error(err.message);
        errorCount++;
      }
    }

    // Copy assets
    const assetsDir = join(distDir, 'server/speech/providers/local/sherpa/assets');
    const sileroPath = join(srcDir, 'server/speech/providers/local/sherpa/assets/silero_vad.onnx');

    if (!existsSync(assetsDir)) {
      mkdirSync(assetsDir, { recursive: true });
    }
    if (existsSync(sileroPath)) {
      copyFileSync(sileroPath, join(assetsDir, 'silero_vad.onnx'));
      console.log('Copied silero_vad.onnx');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\nesbuild completed in ${elapsed}s`);
    console.log(`  Success: ${successCount}`);
    if (errorCount > 0) {
      console.log(`  Errors: ${errorCount}`);
    }

  } catch (error) {
    console.error('esbuild failed:', error);
    process.exit(1);
  }
}

build();