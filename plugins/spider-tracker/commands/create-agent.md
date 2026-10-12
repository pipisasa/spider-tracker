---
description: Create a Spider Tracker agent from an invitation code and a Claude Code agent to run it
argument-hint: "<what the agent should do> [invite code or link]"
---

Set up a Spider Tracker agent for the user, and a Claude Code agent that works as it.

The user's request: $ARGUMENTS

## 1. Read the request

- The **invitation** is an 8-character code like `ABCD-EFGH` (pattern `[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}`, any case) or a link containing `/agent-invite/`. It comes from Spider Tracker's Settings → Agents → Invite an agent.
- Everything else is the **prompt**: what the agent should do.
- If the invitation is missing, ask the user for it (AskUserQuestion, or a plain question) and stop until they answer. If the prompt is missing, ask what the agent should do.

## 2. Name it

From the prompt, propose:

- a short **name** (e.g. `Reviewer`),
- a **handle**: lowercase letters, digits and single dashes (e.g. `code-reviewer`),
- a one-line **description** of what it does.

## 3. Accept the invitation

Run (quote every value):

```bash
spider accept-invite '<code or link>' --name '<name>' --handle '<handle>' --description '<description>' --json
```

If `spider` is not on PATH, run the same with `bun run spider …` from the Spider Tracker repository root.

- Exit 0: stdout is `{"agent":"server/org/handle","actor":…,"organization":…,"projects":[{key,name}],"owner":…,"claudeAgent":{"path":…,"name":…}}`. The key is saved on this machine by the CLI; it is never printed. Note `agent` (the full reference), the organization, the projects and `claudeAgent`.
- Exit 2 with a `conflict` error: the handle is taken. Pick another (e.g. add a suffix) and run it again; the code is still valid.
- Exit 2 with "Invalid or expired invitation code": tell the user and ask for a new code.
- Any other failure: report the message and stop.

## 4. Write the Claude Code agent

Write the file at `claudeAgent.path` from step 3: `~/.claude/agents/spider/<server>/<org>/<handle>.md`, which groups Spider agents by server and organization. Create the folders if needed; if the file exists, ask before replacing it. Use `claudeAgent.name` as the `name`: Claude Code finds agents by name across all folders, so the CLI picks one no other agent file uses (the handle, or the handle prefixed with the server).

```markdown
---
name: <claudeAgent.name>
description: <when to use this agent, from the prompt>
spider-agent: <the "agent" value from step 3, server/org/handle>
---

<The role: a system prompt for this agent, written from the user's prompt — what it does, how it works, what good output looks like.>

## Spider Tracker

You are @<handle> in Spider Tracker (organization <org>), working in: <project keys and names>.

- In sessions started with `spider claude <handle>`, act through the `spider` MCP tools (whoami, list_tasks, start_task, add_comment, …); your inbox (mentions, assignments, replies) arrives as `<channel source="spider" …>` messages — answer with the channel's `reply` tool.
- For one-off CLI calls, use `spider … --as <handle> --json`.
- Stay within your projects. Never put secrets (API keys, tokens, passwords) in tasks or comments.
```

Never write the API key (`spt_…`) anywhere: not in the agent file, not in the chat.

## 5. Finish

Tell the user the agent is ready, which organization and projects it works in, and how to start it:

```bash
spider claude <handle>
```
