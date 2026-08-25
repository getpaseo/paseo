#!/usr/bin/env node

/**
 * Encrypt the keystore password for build-profile.json5 signing config.
 *
 * HarmonyOS SDK 6.x requires passwords to be hex-encoded AES-128-GCM
 * ciphertext decrypted at build time using the material/ directory.
 * Plain-text passwords are rejected. This script replicates the SDK's
 * own encryption path so we can produce a valid storePassword / keyPassword
 * value from the material files and the known plain-text password.
 *
 * Usage:
 *   echo 'your-password' | node packages/harmony/scripts/encrypt-signing-password.mjs packages/harmony/sign
 *
 * The output is a hex string you can paste directly into build-profile.json5.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import crypto from "crypto";

// --- Constants mirrored from the HarmonyOS SDK decipher-util ---

const COMPONENT = new Int8Array([
  49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119,
]);

const DIRS = ["fd", "ac", "ce"];
const PBKDF2_ITERATIONS = 10000;
const PBKDF2_KEY_LENGTH = 16; // 128-bit key for AES-128-GCM
const PBKDF2_DIGEST = "sha256";
const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

// --- File reading helpers ---

function readDirBytes(dirPath) {
  const entries = readdirSync(dirPath);
  if (entries.length !== 1) {
    throw new Error(`Expected exactly 1 file in ${dirPath}, got ${entries.length}`);
  }
  const filePath = resolve(dirPath, entries[0]);
  return new Int8Array(readFileSync(filePath));
}

function readFd(materialDir) {
  const fdDir = resolve(materialDir, DIRS[0]); // 'fd'
  if (!statSync(fdDir).isDirectory()) {
    throw new Error(`${fdDir} is not a directory`);
  }
  const subDirs = readdirSync(fdDir).filter((n) => n !== ".DS_Store");
  if (subDirs.length !== 3) {
    throw new Error(
      `Expected 3 subdirectories in ${fdDir}, got ${subDirs.length}: ${subDirs.join(", ")}`,
    );
  }
  // Sort to ensure deterministic order (SDK uses readdirSync order which is
  // filesystem-dependent; we sort alphabetically)
  subDirs.sort();
  return subDirs.map((d) => readDirBytes(resolve(fdDir, d)));
}

function readSalt(materialDir) {
  const acDir = resolve(materialDir, DIRS[1]); // 'ac'
  return readDirBytes(acDir);
}

function readWorkMaterial(materialDir) {
  const ceDir = resolve(materialDir, DIRS[2]); // 'ce'
  return readDirBytes(ceDir);
}

// --- XOR helpers ---

function xor(a, b) {
  if (a.byteLength !== b.byteLength) {
    throw new Error(`Length mismatch: ${a.byteLength} vs ${b.byteLength}`);
  }
  const result = new Int8Array(a.byteLength);
  for (let i = 0; i < a.byteLength; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

function xorComponents(arrays) {
  for (const arr of arrays) {
    if (arr.length !== 16) {
      throw new Error(`All components must be 16 bytes, got ${arr.length}`);
    }
  }
  let result = xor(arrays[0], arrays[1]);
  for (let i = 2; i < arrays.length; i++) {
    result = xor(result, arrays[i]);
  }
  return Buffer.from(result);
}

// --- Key derivation ---

function getRootKey(fdArrays, salt) {
  // fdArrays is [fd0, fd1, fd2], each Int8Array(16)
  const combined = fdArrays.concat(COMPONENT); // 4 arrays
  const xored = xorComponents(combined);
  // The SDK calls xored.toString() — on a Buffer/Int8Array this is UTF-8
  const passwordStr = xored.toString("utf-8");
  const key = crypto.pbkdf2Sync(
    passwordStr,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST,
  );
  return new Int8Array(key);
}

// --- AES-128-GCM decryption ---

function decrypt(key, data) {
  // data format: 4-byte big-endian ivLen | iv | ciphertext | 16-byte tag
  const ivLen =
    ((data[0] & 0xff) << 24) |
    ((data[1] & 0xff) << 16) |
    ((data[2] & 0xff) << 8) |
    (data[3] & 0xff);
  const iv = data.slice(4, 4 + ivLen);
  const tagStart = data.length - GCM_TAG_LENGTH;
  const ciphertext = data.slice(4 + ivLen, tagStart);
  const authTag = data.slice(tagStart);

  const decipher = crypto.createDecipheriv("aes-128-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = decipher.update(ciphertext);
  const final = decipher.final();
  return Buffer.concat([plaintext, final]);
}

// --- AES-128-GCM encryption (reverse of above) ---

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-128-gcm", key, iv);
  const encrypted = cipher.update(plaintext);
  const final = cipher.final();
  const ciphertext = Buffer.concat([encrypted, final]);
  const authTag = cipher.getAuthTag();

  // Format: 4-byte big-endian ivLen | iv | ciphertext | authTag
  const ivLenBuf = Buffer.alloc(4);
  ivLenBuf.writeUInt32BE(GCM_IV_LENGTH, 0);
  return Buffer.concat([ivLenBuf, iv, ciphertext, authTag]);
}

// --- Main ---

function deriveKey(materialDir) {
  const fdArrays = readFd(materialDir);
  const salt = readSalt(materialDir);
  const rootKey = getRootKey(fdArrays, salt);
  const workMaterial = readWorkMaterial(materialDir);
  const actualKey = decrypt(rootKey, workMaterial);
  return new Int8Array(actualKey);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: encrypt-signing-password.mjs <sign-directory>");
    console.error(
      "Example: node packages/harmony/scripts/encrypt-signing-password.mjs packages/harmony/sign",
    );
    process.exit(1);
  }

  const signDir = resolve(args[0]);
  const materialDir = resolve(signDir, "material");

  if (!statSync(materialDir).isDirectory()) {
    console.error(`Material directory not found: ${materialDir}`);
    process.exit(1);
  }

  // Read password from stdin (so it doesn't appear in shell history)
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const password = Buffer.concat(chunks).toString("utf-8").trim();
    if (!password) {
      console.error("No password provided on stdin.");
      process.exit(1);
    }

    try {
      const key = deriveKey(materialDir);
      const encrypted = encrypt(key, Buffer.from(password, "utf-8"));
      const hex = encrypted.toString("hex");
      console.log(hex);
    } catch (err) {
      console.error("Encryption failed:", err.message);
      process.exit(1);
    }
  });
}

main();
