#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { version: PACKAGE_VERSION } = require('../package.json');
const DEFAULT_PORT = 2000;
const SERVER_READY_TIMEOUT_MS = 15000;
const SERVER_READY_INTERVAL_MS = 500;
const REPO_OWNER = 'tlbx-ai';
const REPO_NAME = 'MidTerm';
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;

async function main() {
  const { launcher, passthrough } = parseArgs(process.argv.slice(2));

  if (launcher.help) {
    printHelp();
    return;
  }

  const target = getPlatformTarget();
  const release = await resolveRelease(launcher.channel);
  const installDir = await ensureInstalledRelease(release, target);
  const mtPath = path.join(installDir, target.binaryName);
  const mthostPath = path.join(installDir, target.hostBinaryName);

  if (!fs.existsSync(mtPath) || !fs.existsSync(mthostPath)) {
    throw new Error(`Downloaded release is incomplete: expected ${target.binaryName} and ${target.hostBinaryName}`);
  }

  const childArgs = passthrough.slice();
  const explicitBind = getArgValue(childArgs, '--bind');
  const explicitPort = parsePortArg(getArgValue(childArgs, '--port'));

  if (!explicitBind) {
    childArgs.push('--bind', '127.0.0.1');
  }

  const browserUrl = buildBrowserUrl(explicitBind ?? '127.0.0.1', explicitPort ?? DEFAULT_PORT);
  const childEnv = {
    ...process.env,
    MIDTERM_LAUNCH_MODE: 'npx',
    MIDTERM_NPX: '1',
    MIDTERM_NPX_CHANNEL: launcher.channel,
    MIDTERM_NPX_PACKAGE_VERSION: PACKAGE_VERSION
  };

  const child = spawn(mtPath, childArgs, {
    stdio: 'inherit',
    env: childEnv
  });

  if (launcher.openBrowser) {
    void openBrowserWhenReady(browserUrl);
  }

  forwardSignal(child, 'SIGINT');
  forwardSignal(child, 'SIGTERM');
  forwardSignal(child, 'SIGHUP');

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

function parseArgs(args) {
  const launcher = {
    help: false,
    channel: 'stable',
    openBrowser: true
  };
  const passthrough = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--') {
      passthrough.push(...args.slice(i + 1));
      break;
    }

    if (arg === '--help-launcher') {
      launcher.help = true;
      continue;
    }

    if (arg === '--no-browser') {
      launcher.openBrowser = false;
      continue;
    }

    if (arg === '--channel') {
      const value = args[i + 1];
      if (value !== 'stable' && value !== 'dev') {
        throw new Error('--channel must be stable or dev');
      }
      launcher.channel = value;
      i++;
      continue;
    }

    passthrough.push(arg);
  }

  return { launcher, passthrough };
}

function printHelp() {
  console.log('@tlbx-ai/midterm launcher');
  console.log('');
  console.log('Usage: npx @tlbx-ai/midterm [--channel stable|dev] [-- <mt args...>]');
  console.log('');
  console.log('Launcher options:');
  console.log('  --channel stable|dev  Choose the release channel (default: stable)');
  console.log('  --no-browser          Do not auto-open MidTerm in the default browser');
  console.log('  --help-launcher       Show launcher help');
  console.log('');
  console.log('All other arguments are passed to mt.');
}

function getPlatformTarget() {
  if (process.platform === 'win32' && process.arch === 'x64') {
    return {
      assetName: 'mt-win-x64.zip',
      binaryName: 'mt.exe',
      hostBinaryName: 'mthost.exe'
    };
  }

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      assetName: 'mt-osx-arm64.tar.gz',
      binaryName: 'mt',
      hostBinaryName: 'mthost'
    };
  }

  if (process.platform === 'darwin' && process.arch === 'x64') {
    return {
      assetName: 'mt-osx-x64.tar.gz',
      binaryName: 'mt',
      hostBinaryName: 'mthost'
    };
  }

  if (process.platform === 'linux' && process.arch === 'x64') {
    return {
      assetName: 'mt-linux-x64.tar.gz',
      binaryName: 'mt',
      hostBinaryName: 'mthost'
    };
  }

  throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
}

async function resolveRelease(channel) {
  const headers = {
    'User-Agent': '@tlbx-ai/midterm',
    'Accept': 'application/vnd.github+json'
  };

  if (channel === 'stable') {
    const release = await fetchJson(`${GITHUB_API}/releases/latest`, headers);
    return mapRelease(release);
  }

  const releases = await fetchJson(`${GITHUB_API}/releases?per_page=50`, headers);
  const prereleases = Array.isArray(releases) ? releases.filter((release) => release.prerelease) : [];
  if (prereleases.length === 0) {
    throw new Error('No dev releases found on GitHub');
  }

  prereleases.sort((left, right) => compareVersions(right.tag_name, left.tag_name));
  return mapRelease(prereleases[0]);
}

function mapRelease(release) {
  if (!release || !release.tag_name || !Array.isArray(release.assets)) {
    throw new Error('Unexpected GitHub release payload');
  }

  return {
    tag: release.tag_name,
    assets: release.assets
  };
}

async function ensureInstalledRelease(release, target) {
  const cacheRoot = getCacheRoot();
  const versionDir = path.join(cacheRoot, sanitizeTag(release.tag));
  const completeMarker = path.join(versionDir, '.complete');
  const targetAsset = release.assets.find((asset) => asset.name === target.assetName);

  if (!targetAsset || !targetAsset.browser_download_url) {
    throw new Error(`Release ${release.tag} does not contain ${target.assetName}`);
  }

  if (fs.existsSync(completeMarker)) {
    return versionDir;
  }

  await fsp.mkdir(cacheRoot, { recursive: true });

  const tempRoot = await fsp.mkdtemp(path.join(cacheRoot, 'staging-'));
  const archivePath = path.join(tempRoot, target.assetName);
  const extractDir = path.join(tempRoot, 'extract');

  try {
    await fsp.mkdir(extractDir, { recursive: true });
    console.error(`MidTerm ${release.tag}: downloading ${target.assetName}`);
    await downloadFile(targetAsset.browser_download_url, archivePath);
    console.error(`MidTerm ${release.tag}: extracting`);
    extractArchive(archivePath, extractDir);
    await ensureExecutableBits(extractDir, target);
    await fsp.rm(versionDir, { recursive: true, force: true });
    await fsp.rename(extractDir, versionDir);
    await fsp.writeFile(completeMarker, `${release.tag}\n`, 'utf8');
    return versionDir;
  } catch (error) {
    await fsp.rm(versionDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function getCacheRoot() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'MidTerm', 'npx-cache');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'MidTerm', 'npx-cache');
  }

  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdgCache, 'midterm', 'npx-cache');
}

function sanitizeTag(tag) {
  return String(tag).replace(/^v/, '');
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function downloadFile(url, filePath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': '@tlbx-ai/midterm'
    }
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  await fsp.writeFile(filePath, Buffer.from(arrayBuffer));
}

function extractArchive(archivePath, destinationPath) {
  if (archivePath.endsWith('.zip')) {
    const command = [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${escapePowerShell(archivePath)}' -DestinationPath '${escapePowerShell(destinationPath)}' -Force`
    ];
    const result = spawnSync('powershell', command, { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`Failed to extract ${path.basename(archivePath)} with PowerShell`);
    }
    return;
  }

  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destinationPath], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`Failed to extract ${path.basename(archivePath)} with tar`);
  }
}

async function ensureExecutableBits(installDir, target) {
  if (process.platform === 'win32') {
    return;
  }

  await Promise.all([
    fsp.chmod(path.join(installDir, target.binaryName), 0o755),
    fsp.chmod(path.join(installDir, target.hostBinaryName), 0o755)
  ]);
}

function hasArg(args, name) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function getArgValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      return args[i + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }

  return undefined;
}

function parsePortArg(value) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }

  return parsed;
}

function buildBrowserUrl(bindAddress, port) {
  const normalized = normalizeHostForBrowser(bindAddress);
  return `https://${normalized}:${port}`;
}

function normalizeHostForBrowser(bindAddress) {
  const raw = String(bindAddress || '').trim();
  if (!raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]') {
    return '127.0.0.1';
  }

  const host = raw.replace(/^\[(.*)\]$/, '$1');
  if (host.includes(':')) {
    return `[${host}]`;
  }

  return host;
}

async function openBrowserWhenReady(url) {
  const ready = await waitForServer(url, SERVER_READY_TIMEOUT_MS);
  if (!ready) {
    console.error(`@tlbx-ai/midterm: server did not become ready within ${SERVER_READY_TIMEOUT_MS}ms, opening browser anyway`);
  }

  openUrl(url);
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await probeUrl(url)) {
      return true;
    }

    await sleep(SERVER_READY_INTERVAL_MS);
  }

  return false;
}

function probeUrl(url) {
  return new Promise((resolve) => {
    const request = https.request(url, {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: SERVER_READY_INTERVAL_MS
    }, (response) => {
      response.resume();
      resolve(true);
    });

    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function openUrl(url) {
  let command;
  let args;

  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const result = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  result.on('error', (error) => {
    console.error(`@tlbx-ai/midterm: failed to open browser automatically: ${error.message}`);
  });
  result.unref();
}

function forwardSignal(child, signal) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

function escapePowerShell(value) {
  return value.replace(/'/g, "''");
}

function compareVersions(leftTag, rightTag) {
  const left = parseVersion(leftTag);
  const right = parseVersion(rightTag);

  for (let i = 0; i < 3; i++) {
    if (left.base[i] !== right.base[i]) {
      return left.base[i] - right.base[i];
    }
  }

  if (left.prerelease === null && right.prerelease !== null) {
    return 1;
  }

  if (left.prerelease !== null && right.prerelease === null) {
    return -1;
  }

  if (left.prerelease === null && right.prerelease === null) {
    return 0;
  }

  return left.prerelease - right.prerelease;
}

function parseVersion(tag) {
  const clean = String(tag).replace(/^v/, '');
  const [basePart, prereleasePart] = clean.split('-', 2);
  const base = basePart.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const prereleaseMatch = prereleasePart ? prereleasePart.match(/\.(\d+)$/) : null;

  return {
    base: [base[0] || 0, base[1] || 0, base[2] || 0],
    prerelease: prereleaseMatch ? Number.parseInt(prereleaseMatch[1], 10) : null
  };
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`@tlbx-ai/midterm: ${message}`);
  process.exit(1);
});
