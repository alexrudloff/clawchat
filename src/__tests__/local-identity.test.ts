/**
 * Local Identity Mode Tests
 *
 * Tests for the Ed25519-based local identity mode (no blockchain).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createIdentity,
  saveIdentity,
  loadIdentity,
  identityExists,
  generateNodeKeyPair,
  sign,
  verify,
  createAttestation,
  verifyAttestation,
  getDataDir,
  identityModeFromPrincipal,
  type FullIdentity,
} from '../identity/keys.js';
import {
  generateLocalIdentity,
  createLocalAttestation,
  verifyLocalAttestation,
} from '../identity/local.js';

// Use a temp directory for tests
const TEST_DIR = '/tmp/clawchat-local-test-' + process.pid;
const ORIGINAL_HOME = process.env.HOME;

describe('Local Identity Mode', () => {
  beforeEach(() => {
    process.env.HOME = TEST_DIR;
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('generateLocalIdentity', () => {
    it('generates valid local identity', () => {
      const id = generateLocalIdentity();

      expect(id.mode).toBe('local');
      expect(id.publicKey).toBeInstanceOf(Uint8Array);
      expect(id.privateKey).toBeInstanceOf(Uint8Array);
      expect(id.publicKey.length).toBe(32);
      expect(id.privateKey.length).toBe(32);
      expect(id.principal).toMatch(/^local:[0-9a-f]{64}$/);
    });

    it('generates unique identities', () => {
      const id1 = generateLocalIdentity();
      const id2 = generateLocalIdentity();

      expect(id1.principal).not.toBe(id2.principal);
    });
  });

  describe('createIdentity with local mode', () => {
    it('creates local identity with all required fields', async () => {
      const id = await createIdentity(false, 'local');

      expect(id.mode).toBe('local');
      expect(id.principal).toMatch(/^local:[0-9a-f]{64}$/);
      expect(id.publicKey).toBeInstanceOf(Uint8Array);
      expect(id.privateKey).toBeInstanceOf(Uint8Array);
      expect(id.publicKey.length).toBe(32);
      expect(id.privateKey.length).toBe(32);
      // Local mode has no mnemonic or wallet keys
      expect(id.mnemonic).toBe('');
      expect(id.walletPublicKeyHex).toBe('');
      expect(id.walletPrivateKeyHex).toBe('');
    });

    it('creates stacks identity when mode is stacks', async () => {
      const id = await createIdentity(true, 'stacks');

      expect(id.mode).toBe('stacks');
      expect(id.principal).toMatch(/^stacks:ST/);
      expect(id.mnemonic).toBeTruthy();
      expect(id.mnemonic.split(' ').length).toBe(24);
    });

    it('defaults to stacks mode for backward compatibility', async () => {
      // When called without mode arg (existing code paths)
      const id = await createIdentity(true);

      expect(id.mode).toBe('stacks');
      expect(id.principal).toMatch(/^stacks:ST/);
    });
  });

  describe('identityModeFromPrincipal', () => {
    it('detects local mode', () => {
      expect(identityModeFromPrincipal('local:abc123')).toBe('local');
    });

    it('detects stacks mode', () => {
      expect(identityModeFromPrincipal('stacks:ST1ABC')).toBe('stacks');
    });

    it('defaults to stacks for unknown prefix', () => {
      expect(identityModeFromPrincipal('unknown:xxx')).toBe('stacks');
    });
  });

  describe('saveIdentity / loadIdentity (local mode)', () => {
    it('encrypts and decrypts local identity', async () => {
      const original = await createIdentity(false, 'local');
      const password = 'test-password-123';

      saveIdentity(original, password);
      const loaded = loadIdentity(password);

      expect(loaded).not.toBeNull();
      expect(loaded!.mode).toBe('local');
      expect(loaded!.principal).toBe(original.principal);
      expect(Buffer.from(loaded!.publicKey).toString('hex'))
        .toBe(Buffer.from(original.publicKey).toString('hex'));
      expect(Buffer.from(loaded!.privateKey).toString('hex'))
        .toBe(Buffer.from(original.privateKey).toString('hex'));
      expect(loaded!.mnemonic).toBe('');
    });

    it('fails with wrong password', async () => {
      const original = await createIdentity(false, 'local');
      saveIdentity(original, 'correct-password');

      expect(() => loadIdentity('wrong-password'))
        .toThrow('Invalid password or corrupted identity file');
    });

    it('preserves nick across save/load', async () => {
      const original = await createIdentity(false, 'local');
      original.nick = 'friday';
      const password = 'test-password-123';

      saveIdentity(original, password);
      const loaded = loadIdentity(password);

      expect(loaded!.nick).toBe('friday');
    });
  });

  describe('Local attestation', () => {
    it('creates valid local attestation', () => {
      const id = generateLocalIdentity();
      const attestation = createLocalAttestation(id, id.publicKey);

      expect(attestation.version).toBe(1);
      expect(attestation.principal).toBe(id.principal);
      expect(attestation.principal).toMatch(/^local:/);
      expect(attestation.domain).toBe('snap2p-nodekey-attestation-v1');
      expect(attestation.signature).toBeInstanceOf(Uint8Array);
      expect(attestation.nonce).toBeInstanceOf(Uint8Array);
      expect(attestation.expiresAt).toBeGreaterThan(attestation.issuedAt);
    });

    it('verifies valid local attestation', () => {
      const id = generateLocalIdentity();
      const attestation = createLocalAttestation(id, id.publicKey);

      expect(verifyLocalAttestation(attestation)).toBe(true);
    });

    it('rejects expired local attestation', () => {
      const id = generateLocalIdentity();
      const attestation = createLocalAttestation(id, id.publicKey, 1);

      // Manually expire it
      attestation.expiresAt = Math.floor(Date.now() / 1000) - 600;

      expect(verifyLocalAttestation(attestation)).toBe(false);
    });

    it('rejects attestation with tampered signature', () => {
      const id = generateLocalIdentity();
      const attestation = createLocalAttestation(id, id.publicKey);

      attestation.signature[0] ^= 0xff;

      expect(verifyLocalAttestation(attestation)).toBe(false);
    });

    it('rejects attestation with tampered principal', () => {
      const id = generateLocalIdentity();
      const attestation = createLocalAttestation(id, id.publicKey);

      // Replace principal with a different local principal
      const otherId = generateLocalIdentity();
      attestation.principal = otherId.principal;

      expect(verifyLocalAttestation(attestation)).toBe(false);
    });

    it('rejects attestation with stacks principal', () => {
      const id = generateLocalIdentity();
      const attestation = createLocalAttestation(id, id.publicKey);

      attestation.principal = 'stacks:ST1ABC';

      expect(verifyLocalAttestation(attestation)).toBe(false);
    });
  });

  describe('createAttestation dispatches by mode', () => {
    it('creates local attestation for local identity', async () => {
      const id = await createIdentity(false, 'local');
      const attestation = await createAttestation(id);

      expect(attestation.version).toBe(1);
      expect(attestation.principal).toMatch(/^local:/);
      expect(attestation.domain).toBe('snap2p-nodekey-attestation-v1');
    });

    it('creates stacks attestation for stacks identity', async () => {
      const id = await createIdentity(true, 'stacks');
      const attestation = await createAttestation(id);

      expect(attestation.version).toBe(1);
      expect(attestation.principal).toMatch(/^stacks:/);
      expect(attestation.domain).toBe('snap2p-nodekey-attestation-v1');
    });
  });

  describe('verifyAttestation dispatches by principal', () => {
    it('verifies local attestation', async () => {
      const id = await createIdentity(false, 'local');
      const attestation = await createAttestation(id);

      expect(verifyAttestation(attestation)).toBe(true);
    });

    it('verifies stacks attestation', async () => {
      const id = await createIdentity(true, 'stacks');
      const attestation = await createAttestation(id);

      expect(verifyAttestation(attestation, true)).toBe(true);
    });
  });

  describe('Cross-mode compatibility', () => {
    it('local identity principal is distinguishable from stacks', async () => {
      const local = await createIdentity(false, 'local');
      const stacks = await createIdentity(true, 'stacks');

      expect(local.principal.startsWith('local:')).toBe(true);
      expect(stacks.principal.startsWith('stacks:')).toBe(true);

      // They should never collide
      expect(local.principal).not.toBe(stacks.principal);
    });

    it('local identity has different mode than stacks', async () => {
      const local = await createIdentity(false, 'local');
      const stacks = await createIdentity(true, 'stacks');

      expect(local.mode).toBe('local');
      expect(stacks.mode).toBe('stacks');
    });
  });
});

describe('Gateway Config with Local Identity', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/clawchat-gw-local-test-${process.pid}`;
    process.env.HOME = testDir;
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('validates local: principal in gateway config', async () => {
    const { validateGatewayConfig } = await import('../daemon/gateway-config.js');

    const config = {
      version: 1,
      p2pPort: 9000,
      identities: [
        {
          principal: 'local:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          nick: 'friday',
          autoload: true,
          allowLocal: true,
          allowedRemotePeers: ['*'],
          openclawWake: true,
        },
      ],
    };

    // Should not throw
    expect(() => validateGatewayConfig(config)).not.toThrow();
  });

  it('accepts local: principals in allowedRemotePeers', async () => {
    const { validateGatewayConfig } = await import('../daemon/gateway-config.js');

    const config = {
      version: 1,
      p2pPort: 9000,
      identities: [
        {
          principal: 'stacks:ST1ABC',
          autoload: true,
          allowLocal: true,
          allowedRemotePeers: ['local:abcdef0123456789'],
          openclawWake: true,
        },
      ],
    };

    expect(() => validateGatewayConfig(config)).not.toThrow();
  });

  it('still rejects invalid principal prefixes', async () => {
    const { validateGatewayConfig } = await import('../daemon/gateway-config.js');
    const { GatewayConfigError } = await import('../types/gateway.js');

    const config = {
      version: 1,
      p2pPort: 9000,
      identities: [
        {
          principal: 'invalid-principal',
          autoload: true,
          allowLocal: true,
          allowedRemotePeers: ['*'],
          openclawWake: true,
        },
      ],
    };

    expect(() => validateGatewayConfig(config)).toThrow(GatewayConfigError);
  });

  it('allows mixed local and stacks identities', async () => {
    const { validateGatewayConfig } = await import('../daemon/gateway-config.js');

    const config = {
      version: 1,
      p2pPort: 9000,
      identities: [
        {
          principal: 'local:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          nick: 'local-agent',
          autoload: true,
          allowLocal: true,
          allowedRemotePeers: ['*'],
          openclawWake: true,
        },
        {
          principal: 'stacks:ST1ABC',
          nick: 'stacks-agent',
          autoload: true,
          allowLocal: true,
          allowedRemotePeers: ['*'],
          openclawWake: true,
        },
      ],
    };

    expect(() => validateGatewayConfig(config)).not.toThrow();
  });
});

describe('IdentityManager with Local Identity', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = `/tmp/clawchat-idmgr-local-test-${process.pid}`;
    process.env.HOME = testDir;
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('loads local identity from per-identity directory', async () => {
    const { IdentityManager } = await import('../daemon/identity-manager.js');
    const { saveIdentity: save } = await import('../identity/keys.js');

    const manager = new IdentityManager();

    // Create local identity
    const identity = await createIdentity(false, 'local');
    const principal = identity.principal;

    // Save in per-identity directory
    const identityDir = path.join(testDir, '.clawchat', 'identities', principal);
    fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });

    const originalDataDir = process.env.CLAWCHAT_DATA_DIR;
    try {
      process.env.CLAWCHAT_DATA_DIR = identityDir;
      save(identity, 'test-password-123');
    } finally {
      if (originalDataDir !== undefined) {
        process.env.CLAWCHAT_DATA_DIR = originalDataDir;
      } else {
        delete process.env.CLAWCHAT_DATA_DIR;
      }
    }

    // Load via IdentityManager
    await manager.loadIdentity(principal, 'test-password-123', {
      principal,
      nick: 'friday',
      autoload: true,
      allowLocal: true,
      allowedRemotePeers: ['*'],
      openclawWake: true,
    });

    // Verify loaded
    expect(manager.isLoaded(principal)).toBe(true);
    expect(manager.isLoaded('friday')).toBe(true);

    const loaded = manager.getIdentity(principal);
    expect(loaded).not.toBeNull();
    expect(loaded!.identity.principal).toBe(principal);
    expect(loaded!.identity.mode).toBe('local');
    expect(loaded!.config.nick).toBe('friday');
  });
});
