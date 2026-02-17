/**
 * Local Identity Provider
 *
 * Ed25519-based identity that doesn't require any blockchain.
 * Uses @noble/curves/ed25519 for key generation and signing.
 * Uses @noble/ciphers for encrypted storage.
 *
 * Identity format: local:<hex-encoded-public-key>
 */

import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import { bytesToHex, hexToBytes } from './wallet-utils.js';

/**
 * Local identity: Ed25519 keypair + human-readable label
 */
export interface LocalIdentityData {
  mode: 'local';
  /** Ed25519 public key (32 bytes) */
  publicKey: Uint8Array;
  /** Ed25519 private key (32 bytes) */
  privateKey: Uint8Array;
  /** Principal in format local:<hex-pubkey> */
  principal: string;
  /** Optional nickname for display */
  nick?: string;
}

/**
 * Generate a new local Ed25519 identity
 */
export function generateLocalIdentity(): LocalIdentityData {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  const principal = `local:${bytesToHex(publicKey)}`;

  return {
    mode: 'local',
    publicKey,
    privateKey,
    principal,
  };
}

/**
 * Create an Ed25519 attestation for local mode
 *
 * For local mode, the attestation is simply an Ed25519 signature
 * over the canonical payload, proving ownership of the public key.
 * No blockchain verification needed.
 */
export function createLocalAttestation(
  identity: LocalIdentityData,
  nodePublicKey: Uint8Array,
  validitySeconds = 86400
): {
  version: number;
  principal: string;
  nodePublicKey: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  nonce: Uint8Array;
  domain: string;
  signature: Uint8Array;
} {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + validitySeconds;
  const nonce = randomBytes(32);

  // Create the same canonical payload structure as stacks attestations
  // but sign with Ed25519 directly
  const payload = JSON.stringify({
    v: 1,
    p: identity.principal,
    npk: bytesToHex(nodePublicKey),
    ts: now,
    exp: expiresAt,
    nonce: bytesToHex(nonce),
    domain: 'snap2p-nodekey-attestation-v1',
  });

  const payloadBytes = new TextEncoder().encode(payload);
  const signature = ed25519.sign(payloadBytes, identity.privateKey);

  return {
    version: 1,
    principal: identity.principal,
    nodePublicKey,
    issuedAt: now,
    expiresAt,
    nonce,
    domain: 'snap2p-nodekey-attestation-v1',
    signature,
  };
}

/**
 * Verify a local mode attestation
 *
 * Extracts the public key from the principal (local:<hex-pubkey>),
 * then verifies the Ed25519 signature.
 */
export function verifyLocalAttestation(
  attestation: {
    version: number;
    principal: string;
    nodePublicKey: Uint8Array;
    issuedAt: number;
    expiresAt: number;
    nonce: Uint8Array;
    domain: string;
    signature: Uint8Array;
  }
): boolean {
  const now = Math.floor(Date.now() / 1000);
  const clockSkewTolerance = 5 * 60; // 5 minutes

  // Check version
  if (attestation.version !== 1) return false;

  // Check domain
  if (attestation.domain !== 'snap2p-nodekey-attestation-v1') return false;

  // Check nonce length (16-32 bytes)
  if (!attestation.nonce || attestation.nonce.length < 16 || attestation.nonce.length > 32) return false;

  // Check not expired
  if (attestation.expiresAt <= now - clockSkewTolerance) return false;

  // Check timestamp not in future
  if (attestation.issuedAt > now + clockSkewTolerance) return false;

  // Check node public key length
  if (attestation.nodePublicKey.length !== 32) return false;

  // Must be a local: principal
  if (!attestation.principal.startsWith('local:')) return false;

  // Extract public key from principal
  const pubKeyHex = attestation.principal.slice(6); // Remove 'local:' prefix
  let identityPublicKey: Uint8Array;
  try {
    identityPublicKey = hexToBytes(pubKeyHex);
  } catch {
    return false;
  }

  if (identityPublicKey.length !== 32) return false;

  // Recreate the payload that was signed
  const payload = JSON.stringify({
    v: attestation.version,
    p: attestation.principal,
    npk: bytesToHex(attestation.nodePublicKey),
    ts: attestation.issuedAt,
    exp: attestation.expiresAt,
    nonce: bytesToHex(attestation.nonce),
    domain: attestation.domain,
  });

  const payloadBytes = new TextEncoder().encode(payload);

  // Verify Ed25519 signature using the identity public key
  try {
    return ed25519.verify(attestation.signature, payloadBytes, identityPublicKey);
  } catch {
    return false;
  }
}
