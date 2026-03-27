---
name: status
description: Check claude-peers broker status, list connected peers, and troubleshoot connectivity issues
user_invocable: true
---

# claude-peers status

Check the health of the claude-peers network.

## Steps

1. Run `bun ${CLAUDE_PLUGIN_ROOT}/cli.ts status` to check broker health and connected peers
2. If the broker is not running, tell the user it will start automatically when a Claude Code session with the plugin loads
3. If there are peers, display them in a readable format
4. If no peers found, explain that other Claude Code sessions need to be running with this plugin installed

## Troubleshooting

- **Broker not responding**: Run `bun ${CLAUDE_PLUGIN_ROOT}/cli.ts kill-broker` then restart a Claude Code session
- **Port conflict**: Set `CLAUDE_PEERS_PORT` environment variable to use a different port (default: 7899)
- **No peers visible**: Ensure other sessions are also using the claude-peers plugin
