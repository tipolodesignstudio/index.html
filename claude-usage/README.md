# Claude usage monitor

A local dashboard that shows your Claude Code token usage live, broken down per session.

It reads the transcripts Claude Code already writes to `~/.claude/projects/**/*.jsonl`.
Each assistant message there records its token usage. The server tails those files every
1.5 seconds and pushes updates to the page over Server-Sent Events. It has no dependencies
and makes no network calls.

## Run

```sh
node claude-usage/server.js
# then open http://127.0.0.1:4317
```

Requires Node 18 or later.

| Option | Default | Meaning |
|---|---|---|
| `--port` | `4317` | Port to listen on |
| `--host` | `127.0.0.1` | Interface to bind (keep it local, since the page shows your prompts) |
| `--days` | `30` | Skip transcript files not modified in this many days |
| `--active` | `5` | A session counts as active if it used tokens in the last N minutes |
| `--dir` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Claude config directory to read |

`GET /api/snapshot` returns the same data as JSON.

## What it shows

- **Summary tiles:** active sessions, tokens today, tokens in the last 5 hours, and the
  current burn rate.
- **Tokens per minute** across all sessions for the last hour.
- **Sessions:** title, project and branch, model, a 30-minute sparkline, burn rate, and
  totals for input, output, cache read and cache write. Subagent usage counts toward
  the parent session.
- **Daily totals** for 14 days, plus a breakdown by model.

## Caveats

- **Costs are estimates** at Claude API list prices (see `PRICES` in `server.js`). On a
  Pro or Max subscription you aren't billed per token, so read them as API-equivalent
  value. They don't show your plan's remaining limit.
- **Only local transcripts are included.** Sessions in claude.ai chat, and Claude Code
  sessions running in the cloud, don't write to this machine, so they don't appear.
- Totals include cache reads, which usually make up most of an agent session's tokens.
  For a measure of work done, look at the Output column.
