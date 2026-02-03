#!/usr/bin/env node

import { Command } from 'commander';
import {
  createIdentity,
  recoverIdentity,
  saveIdentity,
  loadIdentity,
  identityExists,
  isValidMnemonic,
  setNick,
  formatPrincipalWithNick,
  setDataDir,
} from './identity/keys.js';
import { Daemon, IpcClient, isDaemonRunning } from './daemon/server.js';

const program = new Command();

program
  .name('clawchat')
  .description('P2P chat CLI for OpenClaw bots')
  .version('0.1.0')
  .option('-d, --data-dir <path>', 'Custom data directory (for multiple wallets)')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.dataDir) {
      setDataDir(opts.dataDir);
    }
  });

// Identity commands
const identity = program.command('identity').description('Manage identity');

identity
  .command('create')
  .description('Create a new identity with fresh seed phrase')
  .option('--password <password>', 'Password to encrypt identity')
  .option('--password-file <path>', 'Read password from file (recommended)')
  .option('--testnet', 'Use testnet addresses (default)', true)
  .option('--mainnet', 'Use mainnet addresses')
  .action(async (options) => {
    if (identityExists()) {
      console.error(JSON.stringify({
        error: 'Identity already exists. Delete ~/.clawchat/identity.enc to create a new one.',
      }));
      process.exit(1);
    }

    let password: string;
    if (options.passwordFile) {
      const fs = await import('fs');
      try {
        password = fs.readFileSync(options.passwordFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read password file: ${err}` }));
        process.exit(1);
      }
    } else if (options.password) {
      password = options.password;
    } else {
      console.error(JSON.stringify({ error: 'Password required. Use --password-file or --password' }));
      process.exit(1);
    }

    const id = await createIdentity(!options.mainnet);
    saveIdentity(id, password);

    console.log(JSON.stringify({
      status: 'created',
      principal: id.principal,
      address: id.address,
      publicKey: Buffer.from(id.publicKey).toString('hex'),
      mnemonic: id.mnemonic, // IMPORTANT: User must back this up!
      warning: 'SAVE YOUR SEED PHRASE! It cannot be recovered.',
    }));
  });

identity
  .command('recover')
  .description('Recover identity from existing seed phrase')
  .option('--password <password>', 'Password to encrypt identity')
  .option('--password-file <path>', 'Read password from file (recommended)')
  .option('--mnemonic <phrase>', 'BIP39 seed phrase (24 words)')
  .option('--mnemonic-file <path>', 'Read seed phrase from file (recommended)')
  .option('--testnet', 'Use testnet addresses (default)', true)
  .option('--mainnet', 'Use mainnet addresses')
  .action(async (options) => {
    if (identityExists()) {
      console.error(JSON.stringify({
        error: 'Identity already exists. Delete ~/.clawchat/identity.enc first.',
      }));
      process.exit(1);
    }

    // Get password
    let password: string;
    if (options.passwordFile) {
      const fs = await import('fs');
      try {
        password = fs.readFileSync(options.passwordFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read password file: ${err}` }));
        process.exit(1);
      }
    } else if (options.password) {
      password = options.password;
    } else {
      console.error(JSON.stringify({ error: 'Password required. Use --password-file or --password' }));
      process.exit(1);
    }

    // Get mnemonic
    let mnemonic: string;
    if (options.mnemonicFile) {
      const fs = await import('fs');
      try {
        mnemonic = fs.readFileSync(options.mnemonicFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read mnemonic file: ${err}` }));
        process.exit(1);
      }
    } else if (options.mnemonic) {
      mnemonic = options.mnemonic;
    } else {
      console.error(JSON.stringify({ error: 'Seed phrase required. Use --mnemonic-file or --mnemonic' }));
      process.exit(1);
    }

    // Validate mnemonic
    if (!isValidMnemonic(mnemonic)) {
      console.error(JSON.stringify({ error: 'Invalid seed phrase' }));
      process.exit(1);
    }

    try {
      const id = await recoverIdentity(mnemonic, !options.mainnet);
      saveIdentity(id, password);

      console.log(JSON.stringify({
        status: 'recovered',
        principal: id.principal,
        address: id.address,
        publicKey: Buffer.from(id.publicKey).toString('hex'),
      }));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

identity
  .command('show')
  .description('Show current identity')
  .option('--password <password>', 'Password to decrypt identity')
  .option('--password-file <path>', 'Read password from file (recommended)')
  .action(async (options) => {
    let password: string;
    if (options.passwordFile) {
      const fs = await import('fs');
      try {
        password = fs.readFileSync(options.passwordFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read password file: ${err}` }));
        process.exit(1);
      }
    } else if (options.password) {
      password = options.password;
    } else {
      console.error(JSON.stringify({ error: 'Password required. Use --password-file or --password' }));
      process.exit(1);
    }

    try {
      const id = loadIdentity(password);
      if (!id) {
        console.error(JSON.stringify({ error: 'No identity found' }));
        process.exit(1);
      }

      console.log(JSON.stringify({
        principal: id.principal,
        address: id.address,
        publicKey: Buffer.from(id.publicKey).toString('hex'),
        nick: id.nick || null,
        displayName: formatPrincipalWithNick(id.principal, id.nick),
      }));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

identity
  .command('set-nick')
  .description('Set a nickname for your identity')
  .argument('<nickname>', 'Nickname to use (e.g., "Alex")')
  .option('--password <password>', 'Password to decrypt/encrypt identity')
  .option('--password-file <path>', 'Read password from file (recommended)')
  .action(async (nickname, options) => {
    let password: string;
    if (options.passwordFile) {
      const fs = await import('fs');
      try {
        password = fs.readFileSync(options.passwordFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read password file: ${err}` }));
        process.exit(1);
      }
    } else if (options.password) {
      password = options.password;
    } else {
      console.error(JSON.stringify({ error: 'Password required. Use --password-file or --password' }));
      process.exit(1);
    }

    try {
      setNick(password, nickname);
      const id = loadIdentity(password);
      console.log(JSON.stringify({
        status: 'updated',
        nick: nickname,
        displayName: formatPrincipalWithNick(id!.principal, nickname),
      }));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

identity
  .command('clear-nick')
  .description('Remove your nickname')
  .option('--password <password>', 'Password to decrypt/encrypt identity')
  .option('--password-file <path>', 'Read password from file (recommended)')
  .action(async (options) => {
    let password: string;
    if (options.passwordFile) {
      const fs = await import('fs');
      try {
        password = fs.readFileSync(options.passwordFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read password file: ${err}` }));
        process.exit(1);
      }
    } else if (options.password) {
      password = options.password;
    } else {
      console.error(JSON.stringify({ error: 'Password required. Use --password-file or --password' }));
      process.exit(1);
    }

    try {
      setNick(password, undefined);
      console.log(JSON.stringify({ status: 'cleared' }));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

// Daemon commands
const daemon = program.command('daemon').description('Background daemon');

daemon
  .command('start')
  .description('Start the daemon')
  .option('--password <password>', 'Password to decrypt identity (insecure, visible in ps)')
  .option('--password-file <path>', 'Read password from file (recommended)')
  .option('-p, --port <port>', 'P2P listen port', '9000')
  .option('--foreground', 'Run in foreground (default)', true)
  .action(async (options) => {
    if (isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon already running' }));
      process.exit(1);
    }

    // Get password from file or argument
    let password: string;
    if (options.passwordFile) {
      const fs = await import('fs');
      try {
        password = fs.readFileSync(options.passwordFile, 'utf-8').trim();
      } catch (err) {
        console.error(JSON.stringify({ error: `Cannot read password file: ${err}` }));
        process.exit(1);
      }
    } else if (options.password) {
      password = options.password;
    } else {
      console.error(JSON.stringify({ error: 'Password required. Use --password-file or --password' }));
      process.exit(1);
    }

    let id;
    try {
      id = loadIdentity(password);
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }

    if (!id) {
      console.error(JSON.stringify({ error: 'No identity found. Run: clawchat identity create' }));
      process.exit(1);
    }

    const d = new Daemon({
      identity: id,
      p2pPort: parseInt(options.port, 10),
    });

    d.on('started', (info) => {
      console.log(JSON.stringify({ event: 'started', ...info }));
    });

    d.on('p2p:connected', (principal) => {
      console.log(JSON.stringify({ event: 'connected', principal }));
    });

    d.on('p2p:disconnected', (principal) => {
      console.log(JSON.stringify({ event: 'disconnected', principal }));
    });

    d.on('message', (msg) => {
      console.log(JSON.stringify({ event: 'message', ...msg }));
    });

    d.on('error', (err) => {
      console.error(JSON.stringify({ event: 'error', error: String(err) }));
    });

    await d.start();

    process.on('SIGINT', () => d.stop());
    process.on('SIGTERM', () => d.stop());
  });

daemon
  .command('status')
  .description('Check daemon status')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log(JSON.stringify({ running: false }));
      return;
    }

    try {
      const client = new IpcClient();
      const response = await client.send({ cmd: 'status' });
      console.log(JSON.stringify({ running: true, ...(response.data as object) }));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.log(JSON.stringify({ status: 'not_running' }));
      return;
    }

    try {
      const client = new IpcClient();
      await client.send({ cmd: 'stop' });
      console.log(JSON.stringify({ status: 'stopped' }));
    } catch {
      console.log(JSON.stringify({ status: 'stopped' }));
    }
  });

// Message commands (require daemon)
program
  .command('send')
  .description('Send a message to a peer')
  .argument('<to>', 'Recipient principal or alias')
  .argument('<message>', 'Message content')
  .action(async (to, message) => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running. Start with: clawchat daemon start' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const response = await client.send({ cmd: 'send', to, content: message });

      if (response.ok) {
        console.log(JSON.stringify({ status: 'queued', ...(response.data as object) }));
      } else {
        console.error(JSON.stringify({ error: response.error }));
        process.exit(1);
      }
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

program
  .command('recv')
  .description('Receive messages')
  .option('--since <timestamp>', 'Only messages after this timestamp')
  .option('--timeout <seconds>', 'Wait up to N seconds for messages (useful for ACKs)')
  .action(async (options) => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const timeoutMs = options.timeout ? parseInt(options.timeout, 10) * 1000 : undefined;

      const response = await client.send({
        cmd: 'recv',
        since: options.since ? parseInt(options.since, 10) : undefined,
        timeout: timeoutMs,
      });

      if (response.ok) {
        console.log(JSON.stringify(response.data));
      } else {
        console.error(JSON.stringify({ error: response.error }));
        process.exit(1);
      }
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

program
  .command('inbox')
  .description('Show all received messages')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const response = await client.send({ cmd: 'inbox' });
      console.log(JSON.stringify(response.data));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

program
  .command('outbox')
  .description('Show queued outgoing messages')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const response = await client.send({ cmd: 'outbox' });
      console.log(JSON.stringify(response.data));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

// Peer commands (require daemon)
const peers = program.command('peers').description('Manage known peers');

peers
  .command('list')
  .description('List known peers')
  .action(async () => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const response = await client.send({ cmd: 'peers' });
      console.log(JSON.stringify(response.data));
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

peers
  .command('add')
  .description('Add a peer')
  .argument('<principal>', 'Peer principal (stacks:ST...)')
  .argument('<address>', 'Peer address (host:port)')
  .option('--alias <alias>', 'Optional alias')
  .action(async (principal, address, options) => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const response = await client.send({
        cmd: 'peer_add',
        principal,
        address,
        alias: options.alias,
      });

      if (response.ok) {
        console.log(JSON.stringify({ status: 'added', ...(response.data as object) }));
      } else {
        console.error(JSON.stringify({ error: response.error }));
        process.exit(1);
      }
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

peers
  .command('remove')
  .description('Remove a peer')
  .argument('<principal>', 'Peer principal')
  .action(async (principal) => {
    if (!isDaemonRunning()) {
      console.error(JSON.stringify({ error: 'Daemon not running' }));
      process.exit(1);
    }

    try {
      const client = new IpcClient();
      const response = await client.send({ cmd: 'peer_remove', principal });

      if (response.ok) {
        console.log(JSON.stringify({ status: 'removed', principal }));
      } else {
        console.error(JSON.stringify({ error: response.error }));
        process.exit(1);
      }
    } catch (err) {
      console.error(JSON.stringify({ error: String(err) }));
      process.exit(1);
    }
  });

program.parse();
