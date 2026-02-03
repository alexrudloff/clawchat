import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Daemon, IpcClient, isDaemonRunning, type IpcCommand } from '../daemon/server.js';
import { createIdentity } from '../identity/keys.js';

const TEST_DIR = '/tmp/clawchat-daemon-test-' + process.pid;
const ORIGINAL_HOME = process.env.HOME;

describe('Daemon', () => {
  let daemon: Daemon | null = null;

  beforeEach(() => {
    process.env.HOME = TEST_DIR;
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, '.clawchat'), { recursive: true });
  });

  afterEach(async () => {
    if (daemon) {
      daemon.stop(false); // Don't exit process during tests
      daemon = null;
      // Give it time to clean up
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('isDaemonRunning', () => {
    it('returns false when no daemon', () => {
      expect(isDaemonRunning()).toBe(false);
    });

    it('returns false for stale PID file', () => {
      const pidPath = path.join(TEST_DIR, '.clawchat', 'daemon.pid');
      fs.writeFileSync(pidPath, '999999999'); // Non-existent PID

      expect(isDaemonRunning()).toBe(false);
      // Should clean up stale PID
      expect(fs.existsSync(pidPath)).toBe(false);
    });
  });

  describe('Daemon lifecycle', () => {
    it('starts and creates socket', async () => {
      const identity = await createIdentity(true);
      daemon = new Daemon({ identity, p2pPort: 19000 });

      const started = new Promise<void>(resolve => {
        daemon!.on('started', () => resolve());
      });

      await daemon.start();
      await started;

      const socketPath = path.join(TEST_DIR, '.clawchat', 'clawchat.sock');
      expect(fs.existsSync(socketPath)).toBe(true);

      const pidPath = path.join(TEST_DIR, '.clawchat', 'daemon.pid');
      expect(fs.existsSync(pidPath)).toBe(true);
    });

    it('handles IPC status command', async () => {
      const identity = await createIdentity(true);
      daemon = new Daemon({ identity, p2pPort: 19001 });

      await daemon.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      const socketPath = path.join(TEST_DIR, '.clawchat', 'clawchat.sock');
      const response = await sendIpcCommand(socketPath, { cmd: 'status' });

      expect(response.ok).toBe(true);
      expect(response.data).toHaveProperty('principal', identity.principal);
      expect(response.data).toHaveProperty('p2pPort', 19001);
    });

    it('handles peer add/list/remove commands', async () => {
      const identity = await createIdentity(true);
      daemon = new Daemon({ identity, p2pPort: 19002 });

      await daemon.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      const socketPath = path.join(TEST_DIR, '.clawchat', 'clawchat.sock');

      // Add peer
      const addResponse = await sendIpcCommand(socketPath, {
        cmd: 'peer_add',
        principal: 'stacks:STtest123',
        address: '192.168.1.100:9000',
        alias: 'testpeer',
      });
      expect(addResponse.ok).toBe(true);

      // List peers
      const listResponse = await sendIpcCommand(socketPath, { cmd: 'peers' });
      expect(listResponse.ok).toBe(true);
      expect(listResponse.data).toHaveLength(1);
      expect((listResponse.data as any[])[0].principal).toBe('stacks:STtest123');
      expect((listResponse.data as any[])[0].alias).toBe('testpeer');

      // Remove peer
      const removeResponse = await sendIpcCommand(socketPath, {
        cmd: 'peer_remove',
        principal: 'stacks:STtest123',
      });
      expect(removeResponse.ok).toBe(true);

      // Verify removed
      const listResponse2 = await sendIpcCommand(socketPath, { cmd: 'peers' });
      expect((listResponse2.data as any[])).toHaveLength(0);
    });

    it('queues messages for sending', async () => {
      const identity = await createIdentity(true);
      daemon = new Daemon({ identity, p2pPort: 19003 });

      await daemon.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      const socketPath = path.join(TEST_DIR, '.clawchat', 'clawchat.sock');

      // Send message
      const sendResponse = await sendIpcCommand(socketPath, {
        cmd: 'send',
        to: 'stacks:STrecipient',
        content: 'Hello, recipient!',
      });
      expect(sendResponse.ok).toBe(true);
      expect(sendResponse.data).toHaveProperty('id');
      expect(sendResponse.data).toHaveProperty('status', 'queued');

      // Check outbox
      const outboxResponse = await sendIpcCommand(socketPath, { cmd: 'outbox' });
      expect(outboxResponse.ok).toBe(true);
      expect((outboxResponse.data as any[])).toHaveLength(1);
      expect((outboxResponse.data as any[])[0].content).toBe('Hello, recipient!');
    });

    it('persists state across commands', async () => {
      const identity = await createIdentity(true);
      daemon = new Daemon({ identity, p2pPort: 19004 });

      await daemon.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      const socketPath = path.join(TEST_DIR, '.clawchat', 'clawchat.sock');

      // Add peer and send message
      await sendIpcCommand(socketPath, {
        cmd: 'peer_add',
        principal: 'stacks:STpeer1',
        address: '10.0.0.1:9000',
      });

      await sendIpcCommand(socketPath, {
        cmd: 'send',
        to: 'stacks:STpeer1',
        content: 'Test message',
      });

      // Verify files exist
      const peersPath = path.join(TEST_DIR, '.clawchat', 'peers.json');
      const outboxPath = path.join(TEST_DIR, '.clawchat', 'outbox.json');

      expect(fs.existsSync(peersPath)).toBe(true);
      expect(fs.existsSync(outboxPath)).toBe(true);

      const peers = JSON.parse(fs.readFileSync(peersPath, 'utf-8'));
      const outbox = JSON.parse(fs.readFileSync(outboxPath, 'utf-8'));

      expect(peers).toHaveLength(1);
      expect(outbox).toHaveLength(1);
    });
  });
});

// Helper to send IPC command directly
async function sendIpcCommand(socketPath: string, cmd: IpcCommand): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(cmd) + '\n');
    });

    socket.on('data', (data) => {
      response += data.toString();
      if (response.includes('\n')) {
        socket.end();
        resolve(JSON.parse(response.trim()));
      }
    });

    socket.on('error', reject);
    socket.setTimeout(5000);
  });
}
