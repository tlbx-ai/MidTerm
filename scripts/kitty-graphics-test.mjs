#!/usr/bin/env node

import assert from "node:assert/strict";
import process from "node:process";
import { deflateSync } from "node:zlib";

const ESC = "\x1b";
const ST = `${ESC}\\`;
// OpenTUI uses this exact id for its Kitty capability probe. Matching its wire
// contract makes this script a direct compatibility test for OpenCode/OpenTUI.
const QUERY_IMAGE_ID = 31337;
const DISPLAY_IMAGE_ID = QUERY_IMAGE_ID + 1;
const QUERY_TIMEOUT_MS = 2500;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

export function createTestPng(width = 192, height = 128) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.allocUnsafe(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const scanlines = Buffer.allocUnsafe((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4;
      const border = x < 5 || y < 5 || x >= width - 5 || y >= height - 5;
      const divider =
        Math.abs(x - width / 2) < 3 || Math.abs(y - height / 2) < 3;
      const blueTile = x < width / 2 === y < height / 2;
      scanlines[offset] = border || divider ? 240 : blueTile ? 47 : 18;
      scanlines[offset + 1] = border || divider ? 244 : blueTile ? 145 : 24;
      scanlines[offset + 2] = border || divider ? 248 : blueTile ? 255 : 36;
      scanlines[offset + 3] = 255;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createKittyCapabilityQuery(imageId = QUERY_IMAGE_ID) {
  // Query a valid 1x1 RGB payload, then request primary device attributes as
  // the ordering fence prescribed by the Kitty graphics specification.
  return `${ESC}_Gi=${imageId},s=1,v=1,a=q,t=d,f=24;AAAA${ST}${ESC}[c`;
}

export function parseKittyCapabilityResponse(input, imageId = QUERY_IMAGE_ID) {
  const escapedId = String(imageId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const response = new RegExp(
    `${ESC}_G[^;]*i=${escapedId}(?:,[^;]*)?;([^${ESC}]*)${ESC}\\\\`,
  );
  const match = response.exec(input);
  if (match) {
    return { complete: true, supported: match[1] === "OK", message: match[1] };
  }

  // A DA1 reply is the protocol-defined fence: if it arrives before a Kitty
  // response, the terminal has ignored the APC query and does not support TGP.
  if (/\x1b\[\??[0-9;]*c/.test(input)) {
    return {
      complete: true,
      supported: false,
      message: "no Kitty response before DA1",
    };
  }
  return { complete: false, supported: false, message: "waiting" };
}

export function createKittyPngTransmission(png, imageId = DISPLAY_IMAGE_ID) {
  const encoded = png.toString("base64");
  const chunks = encoded.match(/.{1,4096}/g) ?? [];
  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;
      const control =
        index === 0
          ? `a=T,f=100,t=d,i=${imageId},q=1,C=1,c=24,r=10,m=${more}`
          : `q=1,m=${more}`;
      return `${ESC}_G${control};${chunk}${ST}`;
    })
    .join("");
}

function runSelfTest() {
  const png = createTestPng(16, 8);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 8);

  const query = createKittyCapabilityQuery();
  assert.match(query, /a=q,t=d,f=24;AAAA/);
  assert.ok(query.endsWith(`${ESC}[c`));

  assert.deepEqual(parseKittyCapabilityResponse("unrelated"), {
    complete: false,
    supported: false,
    message: "waiting",
  });
  assert.deepEqual(
    parseKittyCapabilityResponse(`${ESC}_Gi=${QUERY_IMAGE_ID};OK${ST}`),
    { complete: true, supported: true, message: "OK" },
  );
  assert.deepEqual(parseKittyCapabilityResponse(`${ESC}[?62;4;22c`), {
    complete: true,
    supported: false,
    message: "no Kitty response before DA1",
  });

  const transmission = createKittyPngTransmission(png);
  assert.match(transmission, /a=T,f=100,t=d/);
  assert.ok(transmission.endsWith(ST));
  process.stdout.write("Kitty graphics protocol self-test passed.\n");
}

async function queryTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this test interactively inside a tlbx terminal.");
  }

  const canSetRawMode = typeof process.stdin.setRawMode === "function";
  const previousRawMode = process.stdin.isRaw;
  if (canSetRawMode) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  // A shell may leave replies to its own startup probes in the shared PTY
  // input queue. Drain those before issuing our ordered Kitty + DA1 probe so a
  // stale device-attributes reply cannot produce a false negative on Windows.
  await new Promise((resolve) => {
    const discard = () => {};
    process.stdin.on("data", discard);
    setTimeout(() => {
      process.stdin.off("data", discard);
      resolve();
    }, 100);
  });

  return await new Promise((resolve) => {
    let received = "";
    const restore = () => {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      if (canSetRawMode) process.stdin.setRawMode(Boolean(previousRawMode));
      process.stdin.pause();
    };
    const finish = (result) => {
      restore();
      resolve({ ...result, received });
    };
    const onData = (chunk) => {
      received = (received + chunk).slice(-8192);
      const result = parseKittyCapabilityResponse(received);
      if (result.complete) finish(result);
    };
    const timeout = setTimeout(
      () =>
        finish({
          complete: true,
          supported: false,
          message: "query timed out",
        }),
      QUERY_TIMEOUT_MS,
    );

    process.stdin.on("data", onData);
    process.stdout.write(createKittyCapabilityQuery());
  });
}

async function runInteractive() {
  const result = await queryTerminal();
  if (!result.supported) {
    process.stderr.write(`Kitty graphics unsupported: ${result.message}\n`);
    if (process.argv.includes("--debug")) {
      process.stderr.write(
        `Response bytes: ${Buffer.from(result.received).toString("hex")}\n`,
      );
    }
    process.exitCode = 2;
    return;
  }

  const png = createTestPng();
  process.stdout.write(`${ESC}[2J${ESC}[H`);
  process.stdout.write(
    "tlbx Kitty graphics: capability query returned OK\r\n\r\n",
  );
  process.stdout.write(createKittyPngTransmission(png));
  process.stdout.write(`${ESC}[11B\r\n`);
  process.stdout.write(
    "PASS: the blue/black four-tile image above was rendered through Kitty TGP.\r\n",
  );
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else {
  await runInteractive();
}
