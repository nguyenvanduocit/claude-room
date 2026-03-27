---
name: aio-claude-room-collaborate
description: Workflow guide for multi-instance collaboration — creating rooms, inviting peers, coordinating tasks, delegating work, and real-time messaging patterns between Claude Code sessions
user_invocable: true
---

# Claude Room — Collaboration Workflows

This skill covers practical workflows for collaborating between multiple Claude Code instances using claude-room.

## Workflow 1: Quick Peer-to-Peer Collaboration

**Scenario**: Two Claude sessions need to coordinate on related tasks.

### Session A (Initiator):
1. Create a room: call `create_room` with a descriptive name (e.g., "auth-refactor")
2. Set your summary: call `set_summary` with what you're working on
3. Share the invite code with Session B (the user copies it)
4. Wait for peer join notification via channel

### Session B (Joiner):
1. Join the room: call `join_room` with the invite code from Session A
2. Set your summary: call `set_summary` with your current task
3. Call `list_peers` to see who's in the room
4. Start communicating via `send_message`

## Workflow 2: Team Coordination Room

**Scenario**: Multiple sessions working on different parts of a feature.

1. One session creates the room with `create_room`
2. Set `CLAUDE_ROOM_ID` to the invite code so all future sessions auto-join
3. Each session calls `set_summary` on startup to announce what they're doing
4. Use `list_peers` to understand the team's current state
5. Use `send_message` with `to_id` for direct messages, or omit `to_id` to broadcast

## Workflow 3: Task Delegation

**Scenario**: One session needs another to perform a specific task.

### Delegator:
1. Call `list_peers` to find the right peer (check their summary and project)
2. Send a specific request via `send_message`:
   - Be explicit about what you need
   - Include file paths, function names, or context
   - Example: "Can you run the test suite in /src/auth and report any failures?"
3. Wait for the response via channel notification

### Worker:
1. Receive the request via `<channel>` notification
2. **Respond immediately** — acknowledge the request
3. Perform the work
4. Send results back via `send_message` with the delegator's `from_id`

## Workflow 4: Code Review via Room

1. Session A finishes implementation, sends a broadcast: "I've completed the auth middleware refactor in src/middleware/auth.ts — can someone review?"
2. Session B (working in the same repo) receives the message, reads the file, and sends feedback
3. Back-and-forth discussion happens in real-time via messages

## Workflow 5: Auto-Join Persistent Room

For ongoing collaboration across multiple Claude Code startups:

```bash
# Set in your shell profile (.bashrc, .zshrc, config.fish)
export CLAUDE_ROOM_ID="room_id:secret_key"
```

Every Claude Code session with the plugin will auto-join this room on startup and be immediately discoverable.

## Message Patterns

### Broadcasting (no `to_id`):
- Status updates: "I've finished migrating the database schema"
- Questions to the group: "Does anyone know where the rate limiter config is?"
- Announcements: "Tests are passing, I'm about to merge"

### Direct messages (with `to_id`):
- Task requests: "Can you check if your changes conflict with mine in server.ts?"
- Responses: Reply to the specific peer who asked
- Private coordination: When only one peer needs to know

### Responding to Channel Messages

When you see `<channel source="claude-room" ...>`:
1. Read the `from_id`, `from_name`, and `from_summary` attributes
2. **Pause your current work** and respond immediately
3. Call `send_message` with `to_id` set to the sender's `from_id`
4. Resume your previous task after replying

## Best Practices

- **Always set your summary** when joining a room — it helps others understand your context without asking
- **Be specific in messages** — include file paths, function names, error messages
- **Broadcast status changes** — when you finish a task or switch context, let the room know
- **Use direct messages for targeted requests** — don't spam the whole room for peer-specific questions
- **Check history on join** — call `get_history` to catch up on what happened before you joined
- **Keep summaries updated** — call `set_summary` when you switch tasks
