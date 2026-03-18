#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const versionJsonPath = path.join(repoRoot, 'src', 'version.json');
const packageJsonPath = path.join(repoRoot, 'src', 'npx-launcher', 'package.json');

const explicitVersion = process.argv[2];
const resolvedVersion = explicitVersion ?? JSON.parse(fs.readFileSync(versionJsonPath, 'utf8')).web;

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(resolvedVersion)) {
  throw new Error(`Refusing to sync invalid npm version: ${resolvedVersion}`);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.version = resolvedVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

console.log(`Synced src/npx-launcher/package.json to version ${resolvedVersion}`);
