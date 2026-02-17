/**
 * Identity and attestation management per SNaP2P SPECS.md
 *
 * Supports two identity modes:
 *
 * 1. **local** (default) — Ed25519 keypair, no blockchain.
 *    Principal: local:<hex-pubkey>
 *
 * 2. **stacks** — Stacks wallet (secp256k1 + BIP39).
 *    Principal: stacks:<address>
 *    Requires @stacks/transactions and @stacks/wallet-sdk.
 *
 * Both modes produce a FullIdentity with Ed25519 node keys.
 */

import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { scrypt } from '@noble/hashes/scrypt';
import { gcm } from '@noble/ciphers/aes';
import * as cborg from 'cborg';
import * as fs from 'fs';
import * as path from 'path';
import type { Identity, NodeKeyAttestation } from '../types.js';
import { bytesToHex, hexToBytes } from './wallet-utils.js';
import {
  generateLocalIdentity,
  createLocalAttestation,
  verifyLocalAttestation,
} from './local.js';

export { bytesToHex, hexToBytes } from './wallet-utils.js';

const IDENTITY_FILE = 'identity.enc';
const ATTESTATION_DOMAIN = 'snap2p-nodekey-attestation-v1';

// Scrypt parameters per SNaP2P (N=2^17 for strong security)
const SCRYPT_N = 131072; // 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

// Configurable data directory (for multi-wallet support)
let customDataDir: string | null = null;

/**
 * Set a custom data directory (for multi-wallet support)
 * Call this before any other identity functions
 */
export function setDataDir(dir: string): void {
  customDataDir = dir;
}

/**
 * Get the current data directory path
 * Checks environment variable first (for per-identity storage in gateway mode)
 */
export function getDataDirPath(): string {
  // Check environment variable first (for per-identity storage)
  if (process.env.CLAWCHAT_DATA_DIR) {
    return process.env.CLAWCHAT_DATA_DIR;
  }

  if (customDataDir) {
    return customDataDir;
  }

  return path.join(process.env.HOME || '~', '.clawchat');
}

export function getDataDir(): string {
  const dir = getDataDirPath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Generate Ed25519 node keypair (for transport)
export function generateNodeKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Identity mode: local (Ed25519) or stacks (blockchain) */
export type IdentityMode = 'local' | 'stacks';

/**
 * Full identity: supports both local and stacks modes.
 *
 * For local mode:
 * - principal = local:<hex-pubkey>
 * - address = hex-pubkey (same as principal suffix)
 * - mnemonic = '' (not used)
 * - walletPublicKeyHex = '' (not used)
 * - walletPrivateKeyHex = '' (not used)
 * - publicKey/privateKey are the identity Ed25519 keys (same as node keys)
 *
 * For stacks mode:
 * - principal = stacks:<address>
 * - address = Stacks address
 * - mnemonic = BIP39 seed phrase (24 words)
 * - walletPublicKeyHex = secp256k1 public key
 * - walletPrivateKeyHex = secp256k1 private key
 * - publicKey/privateKey are Ed25519 node keys (separate from wallet keys)
 */
export interface FullIdentity extends Identity {
  /** BIP39 seed phrase (24 words) — only for stacks mode, empty for local */
  mnemonic: string;
  /** Stacks secp256k1 public key (hex) — only for stacks mode */
  walletPublicKeyHex: string;
  /** Stacks secp256k1 private key (hex) — only for stacks mode */
  walletPrivateKeyHex: string;
  /** Whether this is a testnet identity (stacks mode only) */
  testnet: boolean;
  /** Optional nickname for display */
  nick?: string;
  /** Identity mode: 'local' or 'stacks' */
  mode: IdentityMode;
}

/**
 * Dynamically import the Stacks wallet module.
 * This allows local mode to work without @stacks/* packages installed.
 */
async function importWallet() {
  try {
    return await import('./wallet.js');
  } catch (err) {
    throw new Error(
      'Stacks wallet dependencies not available. Install @stacks/transactions and @stacks/wallet-sdk, ' +
      'or use --mode local for blockchain-free identity.\n' +
      `Original error: ${err}`
    );
  }
}

/**
 * Create new identity.
 *
 * @param testnet - Use testnet (stacks mode only)
 * @param mode - Identity mode: 'local' (default) or 'stacks'
 */
export async function createIdentity(testnet = false, mode: IdentityMode = 'stacks'): Promise<FullIdentity> {
  if (mode === 'local') {
    return createLocalModeIdentity();
  }

  // Stacks mode (original behavior)
  const wallet = await importWallet();
  const walletInstance = await wallet.generateWallet(testnet);
  const nodeKeys = generateNodeKeyPair();

  return {
    principal: walletInstance.principal,
    address: walletInstance.address,
    publicKey: nodeKeys.publicKey,
    privateKey: nodeKeys.privateKey,
    mnemonic: walletInstance.mnemonic,
    walletPublicKeyHex: walletInstance.publicKeyHex,
    walletPrivateKeyHex: walletInstance.privateKeyHex,
    testnet,
    mode: 'stacks',
  };
}

/**
 * Create a local mode identity (Ed25519, no blockchain)
 */
function createLocalModeIdentity(): FullIdentity {
  const local = generateLocalIdentity();

  return {
    principal: local.principal,
    address: bytesToHex(local.publicKey), // Use hex pubkey as "address"
    publicKey: local.publicKey,
    privateKey: local.privateKey,
    mnemonic: '',
    walletPublicKeyHex: '',
    walletPrivateKeyHex: '',
    testnet: false,
    mode: 'local',
  };
}

/**
 * Recover identity from existing seed phrase (stacks mode only)
 * Per SPECS - same principal, new node key for this device
 */
export async function recoverIdentity(mnemonic: string, testnet = false): Promise<FullIdentity> {
  const wallet = await importWallet();
  const walletInstance = await wallet.walletFromSeedPhrase(mnemonic, testnet);
  const nodeKeys = generateNodeKeyPair(); // New node key for this device

  return {
    principal: walletInstance.principal,
    address: walletInstance.address,
    publicKey: nodeKeys.publicKey,
    privateKey: nodeKeys.privateKey,
    mnemonic: walletInstance.mnemonic,
    walletPublicKeyHex: walletInstance.publicKeyHex,
    walletPrivateKeyHex: walletInstance.privateKeyHex,
    testnet,
    mode: 'stacks',
  };
}

// Derive encryption key from password using scrypt
function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_KEYLEN,
  });
}

/**
 * Encrypt and save identity (both modes)
 * Uses scrypt + AES-256-GCM
 */
export function saveIdentity(identity: FullIdentity, password: string): void {
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }

  const dataDir = getDataDir();
  const filePath = path.join(dataDir, IDENTITY_FILE);

  const plaintext = JSON.stringify({
    principal: identity.principal,
    address: identity.address,
    publicKey: bytesToHex(identity.publicKey),
    privateKey: bytesToHex(identity.privateKey),
    mnemonic: identity.mnemonic,
    walletPublicKeyHex: identity.walletPublicKeyHex,
    walletPrivateKeyHex: identity.walletPrivateKeyHex,
    testnet: identity.testnet,
    nick: identity.nick,
    mode: identity.mode || (identity.principal.startsWith('local:') ? 'local' : 'stacks'),
  });

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);

  const cipher = gcm(key, iv);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));

  // Format: version(1) + salt(16) + iv(12) + ciphertext
  // Version 3 for multi-mode support (backward compatible reading of v2)
  const output = new Uint8Array(1 + 16 + 12 + ciphertext.length);
  output[0] = 3; // version 3 (multi-mode identity)
  output.set(salt, 1);
  output.set(iv, 17);
  output.set(ciphertext, 29);

  fs.writeFileSync(filePath, Buffer.from(output), { mode: 0o600 });
}

/**
 * Decrypt and load identity
 */
export function loadIdentity(password: string): FullIdentity | null {
  const filePath = path.join(getDataDirPath(), IDENTITY_FILE);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const data = new Uint8Array(fs.readFileSync(filePath));

  const version = data[0];
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported identity file version: ${version}. Please recreate your identity.`);
  }

  const salt = data.slice(1, 17);
  const iv = data.slice(17, 29);
  const ciphertext = data.slice(29);

  const key = deriveKey(password, salt);

  try {
    const cipher = gcm(key, iv);
    const plaintext = cipher.decrypt(ciphertext);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));

    // Determine mode from saved data or principal prefix
    const mode: IdentityMode = parsed.mode ||
      (parsed.principal?.startsWith('local:') ? 'local' : 'stacks');

    return {
      principal: parsed.principal,
      address: parsed.address,
      publicKey: hexToBytes(parsed.publicKey),
      privateKey: hexToBytes(parsed.privateKey),
      mnemonic: parsed.mnemonic || '',
      walletPublicKeyHex: parsed.walletPublicKeyHex || '',
      walletPrivateKeyHex: parsed.walletPrivateKeyHex || '',
      testnet: parsed.testnet ?? true,
      nick: parsed.nick,
      mode,
    };
  } catch {
    throw new Error('Invalid password or corrupted identity file');
  }
}

export function identityExists(): boolean {
  return fs.existsSync(path.join(getDataDirPath(), IDENTITY_FILE));
}

/**
 * Update the nickname in an existing identity
 */
export function setNick(password: string, nick: string | undefined): void {
  const identity = loadIdentity(password);
  if (!identity) {
    throw new Error('No identity found');
  }
  identity.nick = nick;
  saveIdentity(identity, password);
}

/**
 * Format a principal with optional nick for display
 * Returns "principal(nick)" if nick is set, otherwise just "principal"
 */
export function formatPrincipalWithNick(principal: string, nick?: string): string {
  if (nick) {
    return `${principal}(${nick})`;
  }
  return principal;
}

/**
 * Detect identity mode from a principal string
 */
export function identityModeFromPrincipal(principal: string): IdentityMode {
  if (principal.startsWith('local:')) return 'local';
  if (principal.startsWith('stacks:')) return 'stacks';
  // Default to stacks for backward compatibility
  return 'stacks';
}

// Ed25519 signing (for node key operations)
export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * Create NodeKeyAttestation — dispatches based on identity mode
 *
 * For stacks mode: secp256k1 signature (original behavior)
 * For local mode: Ed25519 signature
 */
export async function createAttestation(
  identity: FullIdentity,
  validitySeconds = 86400
): Promise<NodeKeyAttestation> {
  const mode = identity.mode || identityModeFromPrincipal(identity.principal);

  if (mode === 'local') {
    // Local mode: Ed25519 attestation
    const att = createLocalAttestation(
      {
        mode: 'local',
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        principal: identity.principal,
      },
      identity.publicKey, // node public key = identity public key in local mode
      validitySeconds
    );

    return {
      version: att.version,
      principal: att.principal,
      nodePublicKey: att.nodePublicKey,
      issuedAt: att.issuedAt,
      expiresAt: att.expiresAt,
      nonce: att.nonce,
      domain: att.domain,
      signature: att.signature,
    };
  }

  // Stacks mode: secp256k1 attestation (original behavior)
  const wallet = await importWallet();
  const walletInstance = await wallet.walletFromSeedPhrase(identity.mnemonic, identity.testnet);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiresAt = now + BigInt(validitySeconds);
  const nonce = randomBytes(32); // 32 bytes per SPECS

  // Create canonical payload for signing (CBOR encoded per SPECS)
  const payload = {
    v: 1,
    p: identity.principal,
    npk: bytesToHex(identity.publicKey),
    ts: now,
    exp: expiresAt,
    nonce,
    domain: ATTESTATION_DOMAIN,
  };

  const payloadBytes = cborg.encode(payload);

  // Sign with wallet key (secp256k1)
  const signature = await walletInstance.sign(payloadBytes);

  return {
    version: 1,
    principal: identity.principal,
    nodePublicKey: identity.publicKey,
    issuedAt: Number(now),
    expiresAt: Number(expiresAt),
    nonce,
    domain: ATTESTATION_DOMAIN,
    signature,
  };
}

/**
 * Verify NodeKeyAttestation — dispatches based on principal prefix
 *
 * For stacks: principals — verifies secp256k1 signature via address recovery
 * For local: principals — verifies Ed25519 signature against embedded pubkey
 */
export function verifyAttestation(
  attestation: NodeKeyAttestation,
  testnet = false
): boolean {
  const mode = identityModeFromPrincipal(attestation.principal);

  if (mode === 'local') {
    return verifyLocalAttestation(attestation);
  }

  // Stacks mode — original verification
  return verifyStacksAttestation(attestation, testnet);
}

/**
 * Verify a stacks-mode attestation (secp256k1 signature via address recovery).
 * Kept separate so it can import the wallet module.
 */
function verifyStacksAttestation(
  attestation: NodeKeyAttestation,
  testnet: boolean
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const clockSkewTolerance = 5 * 60; // 5 minutes per SPECS 2.6

  // Check version
  if (attestation.version !== 1) return false;

  // Check domain
  if (attestation.domain !== ATTESTATION_DOMAIN) return false;

  // Check nonce length (16-32 bytes per SPECS)
  if (!attestation.nonce || attestation.nonce.length < 16 || attestation.nonce.length > 32) return false;

  // Check not expired (with clock skew tolerance)
  if (attestation.expiresAt <= now - clockSkewTolerance) return false;

  // Check timestamp not in future (with clock skew tolerance)
  if (attestation.issuedAt > now + clockSkewTolerance) return false;

  // Check node public key length (Ed25519 = 32 bytes)
  if (attestation.nodePublicKey.length !== 32) return false;

  // Recreate the payload that was signed
  const payload = {
    v: attestation.version,
    p: attestation.principal,
    npk: bytesToHex(attestation.nodePublicKey),
    ts: BigInt(attestation.issuedAt),
    exp: BigInt(attestation.expiresAt),
    nonce: attestation.nonce,
    domain: attestation.domain,
  };

  const payloadBytes = cborg.encode(payload);

  // Extract address from principal (stacks:ST... -> ST...)
  const address = attestation.principal.replace('stacks:', '');

  // Import wallet module - we use a cached reference to avoid repeated imports
  if (!_walletModule) {
    try {
      // In ESM, we can't use require(). The wallet module must be pre-loaded
      // by calling ensureWalletModuleLoaded() before verifying stacks attestations.
      console.error('[identity] Warning: wallet module not pre-loaded. Call ensureWalletModuleLoaded() first.');
      return false;
    } catch {
      console.error('[identity] Warning: @stacks/* packages not available for verification');
      return false;
    }
  }

  return _walletModule.verifyWalletSignature(payloadBytes, attestation.signature, address, testnet);
}

// Cached wallet module for synchronous verification
let _walletModule: { verifyWalletSignature: (message: Uint8Array, signature: Uint8Array, address: string, testnet: boolean) => boolean } | null = null;

/**
 * Pre-load the wallet module for stacks attestation verification.
 * Must be called before verifyAttestation() is used with stacks principals.
 * This is a no-op if the module is already loaded.
 */
export async function ensureWalletModuleLoaded(): Promise<void> {
  if (_walletModule) return;
  try {
    _walletModule = await import('./wallet.js');
  } catch {
    // Wallet module not available — stacks mode won't work
  }
}

// Auto-load wallet module on import (best effort)
// This runs asynchronously but the module will be available by the time
// the daemon starts processing attestations.
ensureWalletModuleLoaded().catch(() => {});

/**
 * Serialize attestation to bytes (for wire transmission)
 */
export function serializeAttestation(attestation: NodeKeyAttestation): Uint8Array {
  return cborg.encode({
    v: attestation.version,
    p: attestation.principal,
    npk: bytesToHex(attestation.nodePublicKey),
    ts: BigInt(attestation.issuedAt),
    exp: BigInt(attestation.expiresAt),
    nonce: attestation.nonce,
    domain: attestation.domain,
    sig: attestation.signature,
  });
}

/**
 * Deserialize attestation from bytes
 */
export function deserializeAttestation(data: Uint8Array): NodeKeyAttestation {
  const wire = cborg.decode(data) as {
    v: number;
    p: string;
    npk: string;
    ts: bigint;
    exp: bigint;
    nonce: Uint8Array;
    domain: string;
    sig: Uint8Array;
  };

  if (wire.v !== 1) {
    throw new Error(`Unsupported attestation version: ${wire.v}`);
  }

  return {
    version: 1,
    principal: wire.p,
    nodePublicKey: hexToBytes(wire.npk),
    issuedAt: Number(wire.ts),
    expiresAt: Number(wire.exp),
    nonce: wire.nonce,
    domain: wire.domain,
    signature: wire.sig,
  };
}

/**
 * Validate a BIP39 seed phrase.
 * Only meaningful for stacks mode — dynamically loads wallet module.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  try {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 24) return false;
    return true;
  } catch {
    return false;
  }
}
