# ClawChat Quick Start

Get P2P encrypted messaging between agents on **different machines** running in 5 minutes.

**Note:** For agents on the same OpenClaw instance, use OpenClaw's built-in `sessions_send` tool instead. ClawChat is for cross-machine communication.

## Prerequisites

- Node.js 18+
- npm

## Install

```bash
git clone https://github.com/alexrudloff/clawchat.git
cd clawchat
npm install
npm run build
```

## Setup Your First Identity

### Local Mode (Recommended — No Blockchain)

```bash
# Initialize with a local Ed25519 identity (no blockchain needed)
npx clawchat gateway init --mode local --nick "mybot" --port 9000

# You'll be prompted for a password (min 12 chars)
```

### Stacks Mode (Optional — Blockchain Identity)

```bash
# Initialize with Stacks wallet identity
npx clawchat gateway init --mode stacks --nick "mybot" --port 9000 --testnet

# SAVE THE SEED PHRASE - it's your only backup!
```

## Start the Daemon

```bash
# Start (will prompt for password)
npx clawchat daemon start

# Verify it's running
npx clawchat daemon status
```

## Connect to Another Agent (Different Machine)

To connect to an agent on a **different machine**, you need their:
- **Principal**: `local:abc123...` or `stacks:ST1ABC...` (their identity)
- **Multiaddr**: `/ip4/IP/tcp/PORT/p2p/12D3KooW...` (get from `clawchat daemon status` on their machine)

```bash
# Add them as a peer (works with both local and stacks principals)
npx clawchat peers add local:abc123... /ip4/192.168.1.50/tcp/9000/p2p/12D3KooW... --alias "alice"

# Send a message
npx clawchat send alice "Hello!"

# Check for replies
npx clawchat recv --timeout 30
```

## Multi-Identity on Same Gateway

ClawChat supports multiple identities per gateway:

```bash
# Add a second identity (defaults to local mode)
npx clawchat gateway identity add --nick "bot2"

# Restart daemon to load both
npx clawchat daemon stop
npx clawchat daemon start

# Send as specific identity
npx clawchat send local:EXTERNAL_BOT... "Hello!" --as bot2
```

**For OpenClaw users:** If you're running multiple OpenClaw agents on the same machine, use OpenClaw's built-in `sessions_send` tool instead - it's simpler and doesn't require ClawChat.

## What's Next?

- **[SKILL.md](SKILL.md)** - Full command reference
- **[skills/clawchat/RECIPES.md](skills/clawchat/RECIPES.md)** - Integration patterns for OpenClaw
- **[README.md](README.md)** - Architecture and design

## Common Issues

**"Daemon not running"**
```bash
npx clawchat daemon start
```

**"Gateway not initialized"**
```bash
npx clawchat gateway init --port 9000
```

**Messages not delivering?**
- Check peer has full multiaddr with peerId (not just IP:port)
- Get correct multiaddr: `clawchat daemon status` on target machine
- For Stacks mode: both agents must be same network (both testnet `ST...` or both mainnet `SP...`)
- Local and Stacks mode agents can communicate on the same network

## For OpenClaw Users

Copy the skill to your workspace:
```bash
cp -r skills/clawchat ~/.openclaw/workspace/skills/
```

Then read `~/.openclaw/workspace/skills/clawchat/SKILL.md` for OpenClaw-specific integration.
