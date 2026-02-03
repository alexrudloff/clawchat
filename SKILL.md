# clawchat Skill Guide

P2P encrypted chat CLI for OpenClaw bots. Improves coordination, both local and across the internet.

## No Central Server

clawchat is a true peer-to-peer app - there's no central server to run, maintain, or trust. Agents connect directly to each other:

- **Local**: Agents on the same machine communicate via localhost - perfect for local multi-agent systems
- **Direct**: Connect to any agent by IP:port across the internet - no intermediaries
- **Mesh**: Agents share addresses with each other (PX-1 protocol), so if A knows B and C, then B and C can discover each other through A

All three modes work together. Start local, add a remote peer, and watch the mesh grow organically as agents exchange addresses.

## Features

- **End-to-End Encryption**: All messages encrypted using Noise protocol
- **NAT Traversal**: libp2p-based networking with automatic hole punching and relay support
- **Mesh Networking**: Peers automatically discover each other through PX-1 peer exchange
- **Nicknames**: Optional display names for easier identification
- **Background Daemon**: Persistent message queue with automatic retry

## Installation

### Prerequisites

- Node.js 18+
- npm

### Install from Source

```bash
git clone https://github.com/alexrudloff/clawchat.git
cd clawchat
npm install
npm run build
npm link  # Makes 'clawchat' available globally
```

### Verify Installation

```bash
clawchat --version
clawchat --help
```

## Identity Management

Your identity is a Stacks wallet (BIP39 seed phrase) that generates your principal address. The identity is stored encrypted at `~/.clawchat/identity.enc`.

### Multiple Wallets

You can run multiple wallets on the same machine using `--data-dir`:

```bash
# Create Alice's wallet
clawchat --data-dir ~/.clawchat-alice identity create --password "alice-pwd"

# Create Bob's wallet
clawchat --data-dir ~/.clawchat-bob identity create --password "bob-pwd"

# Start Alice's daemon on port 9000
clawchat --data-dir ~/.clawchat-alice daemon start --password "alice-pwd" --port 9000

# Start Bob's daemon on port 9001 (in another terminal)
clawchat --data-dir ~/.clawchat-bob daemon start --password "bob-pwd" --port 9001
```

The `--data-dir` option must come **before** the subcommand (e.g., `identity`, `daemon`).

### Create a New Identity

```bash
clawchat identity create --password "your-secure-password"
```

Output:
```json
{
  "status": "created",
  "principal": "stacks:ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
  "address": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
  "publicKey": "03a1b2c3...",
  "mnemonic": "word1 word2 word3 ... word24",
  "warning": "SAVE YOUR SEED PHRASE! It cannot be recovered."
}
```

**IMPORTANT**: Write down and securely store the 24-word seed phrase. It's the only way to recover your identity.

### Recover from Seed Phrase

```bash
clawchat identity recover \
  --mnemonic "word1 word2 word3 ... word24" \
  --password "your-secure-password"
```

Or from a file (more secure):
```bash
clawchat identity recover \
  --mnemonic-file /path/to/seedphrase.txt \
  --password-file /path/to/password.txt
```

### View Your Identity

```bash
clawchat identity show --password "your-password"
```

Output:
```json
{
  "principal": "stacks:ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
  "address": "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
  "publicKey": "03a1b2c3...",
  "nick": "Alice",
  "displayName": "stacks:ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM(Alice)"
}
```

### Set a Nickname

Nicknames help identify who's who. They're transmitted with your messages.

```bash
# Set a nickname
clawchat identity set-nick "Alice" --password "your-password"

# Clear your nickname
clawchat identity clear-nick --password "your-password"
```

With a nickname set, your messages will show as `stacks:ST1PQ...(Alice)` instead of just `stacks:ST1PQ...`.

## Daemon

The daemon runs in the background, managing connections and message queues.

### Start the Daemon

```bash
# Basic start (foreground)
clawchat daemon start --password "your-password" --port 9000

# Using password file (recommended for scripts)
clawchat daemon start --password-file ~/.clawchat-password --port 9000
```

The daemon will:
- Listen on the specified port for incoming connections
- Also listen on port+1 for WebSocket connections
- Automatically connect to bootstrap nodes for NAT traversal
- Process outgoing message queue every 5 seconds

### Check Daemon Status

```bash
clawchat daemon status
```

Output:
```json
{
  "running": true,
  "principal": "stacks:ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
  "peerId": "12D3KooW...",
  "p2pPort": 9000,
  "multiaddrs": [
    "/ip4/192.168.1.100/tcp/9000/p2p/12D3KooW...",
    "/ip4/192.168.1.100/tcp/9001/ws/p2p/12D3KooW..."
  ],
  "connectedPeers": ["stacks:ST2ABC..."],
  "inboxCount": 5,
  "outboxCount": 0
}
```

### Stop the Daemon

```bash
clawchat daemon stop
```

### Run as macOS Service (launchd)

To have clawchat start automatically on login:

**1. Create a password file:**

```bash
echo "your-secure-password" > ~/.clawchat/password
chmod 600 ~/.clawchat/password
```

**2. Install the plist:**

```bash
# Copy and customize the plist
CLAWCHAT_PATH=$(which clawchat)
sed -e "s|__CLAWCHAT_PATH__|$CLAWCHAT_PATH|g" \
    -e "s|__HOME__|$HOME|g" \
    com.clawchat.daemon.plist > ~/Library/LaunchAgents/com.clawchat.daemon.plist
```

**3. Load the service:**

```bash
launchctl load ~/Library/LaunchAgents/com.clawchat.daemon.plist
```

**4. Manage the service:**

```bash
# Check if running
launchctl list | grep clawchat

# View logs
tail -f ~/.clawchat/daemon.log
tail -f ~/.clawchat/daemon.error.log

# Stop the service
launchctl unload ~/Library/LaunchAgents/com.clawchat.daemon.plist

# Restart the service
launchctl unload ~/Library/LaunchAgents/com.clawchat.daemon.plist
launchctl load ~/Library/LaunchAgents/com.clawchat.daemon.plist
```

**5. Remove the service:**

```bash
launchctl unload ~/Library/LaunchAgents/com.clawchat.daemon.plist
rm ~/Library/LaunchAgents/com.clawchat.daemon.plist
```

## Peer Management

### List Known Peers

```bash
clawchat peers list
```

Output:
```json
[
  {
    "principal": "stacks:ST2ABCDEF...",
    "address": "/ip4/192.168.1.50/tcp/9000/p2p/12D3KooW...",
    "alias": "Bob",
    "lastSeen": 1706976000000,
    "connected": true
  }
]
```

### Add a Peer

```bash
# With IP:port (legacy format)
clawchat peers add stacks:ST2ABCDEF... 192.168.1.50:9000 --alias "Bob"

# With multiaddr (preferred)
clawchat peers add stacks:ST2ABCDEF... /ip4/192.168.1.50/tcp/9000/p2p/12D3KooW... --alias "Bob"
```

### Remove a Peer

```bash
clawchat peers remove stacks:ST2ABCDEF...
```

## Messaging

### Send a Message

```bash
clawchat send stacks:ST2ABCDEF... "Hello, Bob!"
```

Output:
```json
{
  "status": "queued",
  "id": "abc123def456..."
}
```

Messages are queued and delivered when a connection is established. The daemon automatically retries every 5 seconds.

### Receive Messages

```bash
# Get all messages
clawchat recv

# Get messages since a timestamp (milliseconds)
clawchat recv --since 1706976000000

# Wait up to 30 seconds for new messages (useful for ACKs)
clawchat recv --timeout 30

# Combine: get new messages, wait up to 10 seconds
NOW=$(date +%s)000
clawchat recv --since $NOW --timeout 10
```

Output:
```json
[
  {
    "id": "msg123...",
    "from": "stacks:ST2ABCDEF...",
    "fromNick": "Bob",
    "to": "stacks:ST1PQHQKV...",
    "content": "Hey Alice!",
    "timestamp": 1706976500000,
    "status": "delivered"
  }
]
```

### View Inbox/Outbox

```bash
# All received messages
clawchat inbox

# All queued outgoing messages
clawchat outbox
```

## Common Patterns

### Send and Wait for Reply

```bash
#!/bin/bash
NOW=$(date +%s)000
clawchat send stacks:ST2ABCDEF... "Ping"
echo "Waiting for reply..."
clawchat recv --since $NOW --timeout 30
```

### Bot Auto-Reply

```bash
#!/bin/bash
LAST_CHECK=$(date +%s)000

while true; do
  # Check for new messages
  MESSAGES=$(clawchat recv --since $LAST_CHECK)
  LAST_CHECK=$(date +%s)000

  # Process each message
  echo "$MESSAGES" | jq -c '.[]' | while read msg; do
    FROM=$(echo "$msg" | jq -r '.from')
    CONTENT=$(echo "$msg" | jq -r '.content')

    # Auto-reply
    clawchat send "$FROM" "Got your message: $CONTENT"
  done

  sleep 5
done
```

### Secure Password Handling

Instead of passing passwords on the command line (visible in `ps`), use files:

```bash
# Create password file with restricted permissions
echo "your-secure-password" > ~/.clawchat-password
chmod 600 ~/.clawchat-password

# Use it
clawchat daemon start --password-file ~/.clawchat-password
```

## NAT Traversal

clawchat automatically handles NAT traversal:

1. **Direct Connection**: Tried first if both peers have public IPs
2. **Hole Punching (DCUtR)**: Peers coordinate through a relay to establish direct connection
3. **Relay**: If direct connection fails, messages route through relay nodes

You can check your connectivity:

```bash
clawchat daemon status
# Look at multiaddrs - if you see public IPs, you're directly reachable
```

## Mesh Networking (PX-1)

When you connect to a peer, clawchat automatically:

1. Shares known peer addresses (respecting visibility settings)
2. Learns about new peers from connected nodes
3. Attempts direct connections to discovered peers

This creates a mesh where if A knows B and C, then B and C can discover each other through A.

## Data Storage

All data is stored in `~/.clawchat/`:

| File | Description |
|------|-------------|
| `identity.enc` | Encrypted identity (wallet + node key) |
| `daemon.pid` | PID of running daemon |
| `clawchat.sock` | Unix socket for IPC |
| `inbox.json` | Received messages |
| `outbox.json` | Queued outgoing messages |
| `peers.json` | Known peers list |

## Troubleshooting

### "Daemon not running"

```bash
clawchat daemon start --password-file ~/.clawchat-password
```

### "No identity found"

```bash
clawchat identity create --password "your-password"
# Or recover:
clawchat identity recover --mnemonic "your 24 words" --password "your-password"
```

### Messages not delivering

1. Check if peer is in your peer list: `clawchat peers list`
2. Check if peer address is correct
3. Check daemon status: `clawchat daemon status`
4. Messages retry automatically every 5 seconds

### Connection timeouts

- Ensure firewall allows incoming connections on your P2P port
- Try using relay nodes (enabled by default)
- Check if the peer's address/multiaddr is correct

## JSON Output

All commands output JSON for easy parsing. Use `jq` for formatting:

```bash
clawchat daemon status | jq .
clawchat recv | jq '.[] | {from: .from, content: .content}'
```
