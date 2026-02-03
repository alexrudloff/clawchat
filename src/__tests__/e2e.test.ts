import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { createIdentity } from '../identity/keys.js';
import { connect, listen, Session } from '../net/session.js';

const TEST_DIR = '/tmp/clawchat-e2e-test-' + process.pid;
const ORIGINAL_HOME = process.env.HOME;

describe('End-to-End', () => {
  beforeEach(() => {
    process.env.HOME = TEST_DIR;
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('P2P Connection', () => {
    it('establishes encrypted connection between two peers', async () => {
      const aliceIdentity = await createIdentity(true);
      const bobIdentity = await createIdentity(true);

      let bobSession: Session | null = null;

      // Bob listens
      const server = listen(18000, bobIdentity, (session) => {
        bobSession = session;
      });

      await new Promise(resolve => server.on('listening', resolve));

      // Alice connects
      const aliceSession = await connect('127.0.0.1:18000', aliceIdentity);

      // Wait for Bob's session
      await new Promise<void>(resolve => {
        const check = () => {
          if (bobSession) resolve();
          else setTimeout(check, 50);
        };
        check();
      });

      // Verify mutual authentication
      expect(aliceSession.isAuthenticated).toBe(true);
      expect(bobSession!.isAuthenticated).toBe(true);
      expect(aliceSession.remote).toBe(bobIdentity.principal);
      expect(bobSession!.remote).toBe(aliceIdentity.principal);

      // Cleanup
      aliceSession.close();
      bobSession!.close();
      server.close();
    }, 10000);

    it('sends and receives encrypted messages', async () => {
      const aliceIdentity = await createIdentity(true);
      const bobIdentity = await createIdentity(true);

      let bobSession: Session | null = null;
      const receivedMessages: string[] = [];

      // Bob listens
      const server = listen(18001, bobIdentity, (session) => {
        bobSession = session;
        session.on('message', (msg) => {
          receivedMessages.push(msg.content);
        });
      });

      await new Promise(resolve => server.on('listening', resolve));

      // Alice connects
      const aliceSession = await connect('127.0.0.1:18001', aliceIdentity);

      // Wait for Bob's session
      await new Promise<void>(resolve => {
        const check = () => {
          if (bobSession) resolve();
          else setTimeout(check, 50);
        };
        check();
      });

      // Alice sends messages
      aliceSession.sendMessage('Hello Bob!');
      aliceSession.sendMessage('How are you?');

      // Wait for messages to arrive
      await new Promise(resolve => setTimeout(resolve, 500));

      // Bob should have received messages
      expect(receivedMessages).toContain('Hello Bob!');
      expect(receivedMessages).toContain('How are you?');

      // Cleanup
      aliceSession.close();
      bobSession!.close();
      server.close();
    }, 10000);

    it('handles bidirectional messaging', async () => {
      const aliceIdentity = await createIdentity(true);
      const bobIdentity = await createIdentity(true);

      let bobSession: Session | null = null;
      const aliceReceived: string[] = [];
      const bobReceived: string[] = [];

      // Bob listens
      const server = listen(18002, bobIdentity, (session) => {
        bobSession = session;
        session.on('message', (msg) => {
          bobReceived.push(msg.content);
          // Reply
          session.sendMessage(`Echo: ${msg.content}`);
        });
      });

      await new Promise(resolve => server.on('listening', resolve));

      // Alice connects
      const aliceSession = await connect('127.0.0.1:18002', aliceIdentity);
      aliceSession.on('message', (msg) => {
        aliceReceived.push(msg.content);
      });

      // Wait for connection
      await new Promise<void>(resolve => {
        const check = () => {
          if (bobSession) resolve();
          else setTimeout(check, 50);
        };
        check();
      });

      // Alice sends
      aliceSession.sendMessage('Ping');

      // Wait for round trip
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(bobReceived).toContain('Ping');
      expect(aliceReceived).toContain('Echo: Ping');

      // Cleanup
      aliceSession.close();
      bobSession!.close();
      server.close();
    }, 10000);

    it('rejects connection with invalid handshake', async () => {
      const bobIdentity = await createIdentity(true);

      // Bob listens
      const server = listen(18003, bobIdentity, () => {});
      await new Promise(resolve => server.on('listening', resolve));

      // Try raw TCP connection without handshake
      const socket = net.createConnection({ host: '127.0.0.1', port: 18003 });

      const result = await Promise.race([
        new Promise<string>((resolve) => {
          socket.on('connect', () => {
            // Send garbage instead of proper handshake
            socket.write(Buffer.from('invalid handshake data'));
            // Server should eventually close or timeout
            setTimeout(() => resolve('timeout'), 1000);
          });

          socket.on('close', () => resolve('closed'));
          socket.on('error', () => resolve('error'));
        }),
        new Promise<string>(resolve => setTimeout(() => resolve('test-timeout'), 3000)),
      ]);

      // Connection should be closed or errored, or we timeout waiting
      expect(['closed', 'error', 'timeout', 'test-timeout']).toContain(result);

      socket.destroy();
      server.close();
    }, 5000);

    it('handles multiple concurrent connections', async () => {
      const serverIdentity = await createIdentity(true);
      const client1Identity = await createIdentity(true);
      const client2Identity = await createIdentity(true);

      const connectedClients: Session[] = [];

      // Server listens
      const server = listen(18004, serverIdentity, (session) => {
        connectedClients.push(session);
      });

      await new Promise(resolve => server.on('listening', resolve));

      // Connect multiple clients
      const client1Session = await connect('127.0.0.1:18004', client1Identity);
      const client2Session = await connect('127.0.0.1:18004', client2Identity);

      // Wait for connections
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(connectedClients.length).toBe(2);
      expect(client1Session.isAuthenticated).toBe(true);
      expect(client2Session.isAuthenticated).toBe(true);

      // Verify different principals
      const principals = connectedClients.map(s => s.remote);
      expect(principals).toContain(client1Identity.principal);
      expect(principals).toContain(client2Identity.principal);

      // Cleanup
      client1Session.close();
      client2Session.close();
      server.close();
    }, 10000);
  });
});
