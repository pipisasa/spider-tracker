---
description: Create a Spider Tracker agent from an invitation code and a Claude Code agent to run it
argument-hint: "<what the agent should do> [invite code or link]"
---

Set up a Spider Tracker agent for the user, and a Claude Code agent that works as it. The `spider` CLI does the work: it saves the agent's key on this machine and writes its Claude Code agent into its private `spider-agents` plugin. Don't write agent files yourself.

The user's request: $ARGUMENTS

## 1. Check the CLI

Run `spider --version`. If `spider` is not installed, install it (show the user the command and what it does: it downloads the `spider` binary from the project's GitHub releases into `~/.local/bin`):

```bash
curl -fsSL https://tracker.batele.plus/install.sh | sh
```

If `~/.local/bin` isn't on `PATH`, add it (e.g. `export PATH="$HOME/.local/bin:$PATH"` in the shell profile) and use `~/.local/bin/spider` for the rest of this session. Then run `spider setup claude`.

Always use the installed `spider`, even inside the Spider Tracker repository: never substitute `bun run spider`. The plugin's MCP server and `spider claude` call the installed binary, so an agent set up through the development version leaves the tracker tools without a key.

## 2. Read the request

- The **invitation** is an 8-character code like `ABCD-EFGH` (pattern `[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}`, any case) or a link containing `/agent-invite/`. It comes from Spider Tracker's Settings → Agents → Invite an agent.
- Everything else says what the agent should do.
- If the invitation is missing, ask the user for it (AskUserQuestion, or a plain question) and stop until they answer. If it's unclear what the agent should do, ask.

## 3. Name it and write its role

From the request, propose:

- a short **name** (e.g. `Reviewer`),
- a **handle**: lowercase letters, digits and single dashes (e.g. `code-reviewer`),
- a one-line **description** of when to use it,
- a **role prompt**: its system prompt — what it does, how it works, what good output looks like. The CLI adds how to work in Spider Tracker (MCP tools, inbox, projects, no secrets), so leave that out.

## 4. Accept the invitation

Run (quote every value):

```bash
spider accept-invite '<code or link>' --name '<name>' --handle '<handle>' --description '<description>' --prompt '<role prompt>' --json
```

- Exit 0: stdout is `{"agent":"server/org/handle","actor":…,"organization":…,"projects":[{key,name}],"owner":…,"claudeAgent":{"plugin","name","path","qualifiedName"}}`. The key is saved by the CLI and never printed. A note on stderr about Claude Code or the plugin is worth passing on to the user.
- Exit 2 with a `conflict` error: the handle is taken. Pick another (e.g. add a suffix) and run it again; the code is still valid.
- Exit 2 with "Invalid or expired invitation code": tell the user and ask for a new code.
- Any other failure: report the message and stop.

Never write the API key (`spt_…`) anywhere: not in a file, not in the chat.

## 5. Finish

Tell the user the agent is ready, which organization and projects it works in, and how to start Claude Code as it:

```bash
spider claude <handle>
```
