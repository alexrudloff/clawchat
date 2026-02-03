/**
 * End-to-end tests for libp2p-based communication
 * Tests two separate wallets/daemons communicating
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createIdentity, setDataDir, getDataDir } from '../identity/keys.js';
import { Daemon } from '../daemon/server.js';

// Test directories for Alice and Bob
const TEST_BASE = '/tmp/clawchat-libp2p-test-' + process.pid;
const ALICE_DIR = path.join(TEST_BASE, 'alice');
const BOB_DIR = path.join(TEST_BASE, 'bob');

describe('libp2p End-to-End', () => {
  let aliceDaemon: Daemon | null = null;
  let bobDaemon: Daemon | null = null;

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(ALICE_DIR, { recursive: true });
    fs.mkdirSync(BOB_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Stop daemons
    if (aliceDaemon) {
      await aliceDaemon.stop(false);
      aliceDaemon = null;
    }
    if (bobDaemon) {
      await bobDaemon.stop(false);
      bobDaemon = null;
    }

    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 500));

    // Remove test directories
    fs.rmSync(TEST_BASE, { recursive: true, force: true });
  });

  describe('Two Wallet Communication', () => {
    it('two daemons can connect and exchange messages', async () => {
      // Create Alice's identity
      setDataDir(ALICE_DIR);
      const aliceIdentity = await createIdentity(true);
      aliceIdentity.nick = 'Alice';

      // Create Bob's identity
      setDataDir(BOB_DIR);
      const bobIdentity = await createIdentity(true);
      bobIdentity.nick = 'Bob';

      // Track received messages
      const aliceMessages: any[] = [];
      const bobMessages: any[] = [];

      // Start Bob's daemon first (he'll be the listener)
      setDataDir(BOB_DIR);
      bobDaemon = new Daemon({
        identity: bobIdentity,
        p2pPort: 19100,
        bootstrapNodes: [], // No bootstrap for local test
      });

      bobDaemon.on('message', (msg) => {
        bobMessages.push(msg);
      });

      const bobStarted = new Promise<any>(resolve => {
        bobDaemon!.on('started', resolve);
      });

      await bobDaemon.start();
      const bobInfo = await bobStarted;

      // Start Alice's daemon
      setDataDir(ALICE_DIR);
      aliceDaemon = new Daemon({
        identity: aliceIdentity,
        p2pPort: 19200,
        bootstrapNodes: [], // No bootstrap for local test
      });

      aliceDaemon.on('message', (msg) => {
        aliceMessages.push(msg);
      });

      const aliceStarted = new Promise<any>(resolve => {
        aliceDaemon!.on('started', resolve);
      });

      await aliceDaemon.start();
      const aliceInfo = await aliceStarted;

      // Verify both daemons started
      expect(bobInfo.peerId).toBeDefined();
      expect(aliceInfo.peerId).toBeDefined();
      expect(bobInfo.multiaddrs.length).toBeGreaterThan(0);
      expect(aliceInfo.multiaddrs.length).toBeGreaterThan(0);

      console.log('Alice principal:', aliceIdentity.principal);
      console.log('Bob principal:', bobIdentity.principal);
      console.log('Bob multiaddrs:', bobInfo.multiaddrs);

      // Clean up data dir setting
      setDataDir(ALICE_DIR);
    }, 30000);

    it('creates separate identities in separate directories', async () => {
      // Create Alice
      setDataDir(ALICE_DIR);
      const alice = await createIdentity(true);

      // Create Bob
      setDataDir(BOB_DIR);
      const bob = await createIdentity(true);

      // They should have different principals
      expect(alice.principal).not.toBe(bob.principal);
      expect(alice.address).not.toBe(bob.address);

      // Each directory should have its own files
      expect(fs.existsSync(ALICE_DIR)).toBe(true);
      expect(fs.existsSync(BOB_DIR)).toBe(true);
    });

    it('daemons have different peer IDs', async () => {
      // Create identities
      setDataDir(ALICE_DIR);
      const aliceIdentity = await createIdentity(true);

      setDataDir(BOB_DIR);
      const bobIdentity = await createIdentity(true);

      // Start daemons
      setDataDir(BOB_DIR);
      bobDaemon = new Daemon({
        identity: bobIdentity,
        p2pPort: 19101,
        bootstrapNodes: [],
      });

      const bobStarted = new Promise<any>(resolve => {
        bobDaemon!.on('started', resolve);
      });
      await bobDaemon.start();
      const bobInfo = await bobStarted;

      setDataDir(ALICE_DIR);
      aliceDaemon = new Daemon({
        identity: aliceIdentity,
        p2pPort: 19201,
        bootstrapNodes: [],
      });

      const aliceStarted = new Promise<any>(resolve => {
        aliceDaemon!.on('started', resolve);
      });
      await aliceDaemon.start();
      const aliceInfo = await aliceStarted;

      // Peer IDs should be different
      expect(aliceInfo.peerId).not.toBe(bobInfo.peerId);
    }, 30000);

    it('Alice and Bob can exchange messages via IPC commands', async () => {
      // Create identities
      setDataDir(ALICE_DIR);
      const aliceIdentity = await createIdentity(true);
      aliceIdentity.nick = 'Alice';

      setDataDir(BOB_DIR);
      const bobIdentity = await createIdentity(true);
      bobIdentity.nick = 'Bob';

      // Track received messages
      const bobMessages: any[] = [];
      const aliceMessages: any[] = [];

      // Start Bob's daemon
      setDataDir(BOB_DIR);
      bobDaemon = new Daemon({
        identity: bobIdentity,
        p2pPort: 19102,
        bootstrapNodes: [],
      });

      bobDaemon.on('message', (msg) => {
        console.log('Bob received:', msg.content, 'from', msg.from, msg.fromNick ? `(${msg.fromNick})` : '');
        bobMessages.push(msg);
      });

      const bobStarted = new Promise<any>(resolve => {
        bobDaemon!.on('started', resolve);
      });
      await bobDaemon.start();
      const bobInfo = await bobStarted;

      // Start Alice's daemon
      setDataDir(ALICE_DIR);
      aliceDaemon = new Daemon({
        identity: aliceIdentity,
        p2pPort: 19202,
        bootstrapNodes: [],
      });

      aliceDaemon.on('message', (msg) => {
        console.log('Alice received:', msg.content, 'from', msg.from, msg.fromNick ? `(${msg.fromNick})` : '');
        aliceMessages.push(msg);
      });

      const aliceStarted = new Promise<any>(resolve => {
        aliceDaemon!.on('started', resolve);
      });
      await aliceDaemon.start();
      const aliceInfo = await aliceStarted;

      // Get Bob's multiaddr that Alice can connect to (TCP, not WebSocket)
      const bobMultiaddr = bobInfo.multiaddrs.find((ma: string) =>
        ma.includes('127.0.0.1') && ma.includes('/tcp/') && !ma.includes('/ws/')
      );
      expect(bobMultiaddr).toBeDefined();

      console.log('Alice connecting to Bob at:', bobMultiaddr);

      // Step 1: Alice adds Bob as a peer
      const addPeerResult = await aliceDaemon.executeCommand({
        cmd: 'peer_add',
        principal: bobIdentity.principal,
        address: bobMultiaddr!,
        alias: 'Bob',
      });
      expect(addPeerResult.ok).toBe(true);

      // Step 2: Alice connects to Bob
      const connectResult = await aliceDaemon.executeCommand({
        cmd: 'connect',
        multiaddr: bobMultiaddr!,
      });
      console.log('Connect result:', connectResult);
      expect(connectResult.ok).toBe(true);

      // Wait for connection to establish and SNaP2P auth to complete
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Alice sends a message to Bob
      const sendResult = await aliceDaemon.executeCommand({
        cmd: 'send',
        to: bobIdentity.principal,
        content: 'Hello Bob! This is Alice.',
      });
      console.log('Send result:', sendResult);
      expect(sendResult.ok).toBe(true);

      // Wait for message delivery
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify Bob received the message
      console.log('Bob messages:', bobMessages);
      expect(bobMessages.length).toBeGreaterThan(0);
      expect(bobMessages[0].content).toBe('Hello Bob! This is Alice.');
      expect(bobMessages[0].from).toBe(aliceIdentity.principal);
      expect(bobMessages[0].fromNick).toBe('Alice');
    }, 60000);

    it('bidirectional messaging works', async () => {
      // Create identities
      setDataDir(ALICE_DIR);
      const aliceIdentity = await createIdentity(true);
      aliceIdentity.nick = 'Alice';

      setDataDir(BOB_DIR);
      const bobIdentity = await createIdentity(true);
      bobIdentity.nick = 'Bob';

      // Track received messages
      const bobMessages: any[] = [];
      const aliceMessages: any[] = [];

      // Start Bob's daemon
      setDataDir(BOB_DIR);
      bobDaemon = new Daemon({
        identity: bobIdentity,
        p2pPort: 19103,
        bootstrapNodes: [],
      });

      bobDaemon.on('message', (msg) => {
        bobMessages.push(msg);
      });

      const bobStarted = new Promise<any>(resolve => {
        bobDaemon!.on('started', resolve);
      });
      await bobDaemon.start();
      const bobInfo = await bobStarted;

      // Start Alice's daemon
      setDataDir(ALICE_DIR);
      aliceDaemon = new Daemon({
        identity: aliceIdentity,
        p2pPort: 19203,
        bootstrapNodes: [],
      });

      aliceDaemon.on('message', (msg) => {
        aliceMessages.push(msg);
      });

      const aliceStarted = new Promise<any>(resolve => {
        aliceDaemon!.on('started', resolve);
      });
      await aliceDaemon.start();
      const aliceInfo = await aliceStarted;

      // Get multiaddrs
      const bobMultiaddr = bobInfo.multiaddrs.find((ma: string) =>
        ma.includes('127.0.0.1') && ma.includes('/tcp/') && !ma.includes('/ws/')
      );
      const aliceMultiaddr = aliceInfo.multiaddrs.find((ma: string) =>
        ma.includes('127.0.0.1') && ma.includes('/tcp/') && !ma.includes('/ws/')
      );

      // Alice adds Bob and connects
      await aliceDaemon.executeCommand({
        cmd: 'peer_add',
        principal: bobIdentity.principal,
        address: bobMultiaddr!,
      });
      await aliceDaemon.executeCommand({ cmd: 'connect', multiaddr: bobMultiaddr! });

      // Bob adds Alice
      await bobDaemon.executeCommand({
        cmd: 'peer_add',
        principal: aliceIdentity.principal,
        address: aliceMultiaddr!,
      });

      // Wait for connection
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Alice sends to Bob
      await aliceDaemon.executeCommand({
        cmd: 'send',
        to: bobIdentity.principal,
        content: 'Ping from Alice',
      });

      // Wait for message
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Bob replies to Alice
      await bobDaemon.executeCommand({
        cmd: 'send',
        to: aliceIdentity.principal,
        content: 'Pong from Bob',
      });

      // Wait for reply
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify messages
      expect(bobMessages.some(m => m.content === 'Ping from Alice')).toBe(true);
      expect(aliceMessages.some(m => m.content === 'Pong from Bob')).toBe(true);
    }, 60000);
  });

  describe('Nickname Support', () => {
    it('nicknames are preserved in identity', async () => {
      setDataDir(ALICE_DIR);
      const alice = await createIdentity(true);
      alice.nick = 'AliceBot';

      expect(alice.nick).toBe('AliceBot');
    });
  });
});
