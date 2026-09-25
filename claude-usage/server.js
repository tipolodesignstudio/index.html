#!/usr/bin/env node
// Claude usage tracker: tails Claude Code session transcripts in ~/.claude/projects
// and serves a live dashboard of token consumption per session.
// Zero dependencies. Usage: node server.js [--port 4317] [--days 30] [--active 5]

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PORT = Number(arg('port', process.env.PORT || 4317));
const HOST = arg('host', '127.0.0.1');
const HISTORY_DAYS = Number(arg('days', 30));
const ACTIVE_MINUTES = Number(arg('active', 5));
const CLAUDE_DIR = arg('dir', process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const POLL_MS = 1500;
const RESCAN_MS = 10000;

// USD per million tokens: [input, output, cache read]. Cache writes are billed at
// 1.25x input (5-minute TTL) and 2x input (1-hour TTL). Matched by model-id prefix.
// These are API list prices; on a Pro/Max plan the figure is an API-equivalent estimate.
const PRICES = [
  ['claude-fable-5', 10, 50, 0.25],
  ['claude-mythos-5', 10, 50, 1.0],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-3-5-haiku', 0.8, 4, 0.08],
];

function priceFor(model) {
  const row = PRICES.find(([prefix]) => model.startsWith(prefix));
  return row ? { input: row[1], output: row[2], read: row[3] } : null;
}

function costOf(model, u) {
  const p = priceFor(model);
  if (!p) return 0;
  return (
    u.input * p.input +
    u.output * p.output +
    u.cacheRead * p.read +
    u.cacheWrite5m * p.input * 1.25 +
    u.cacheWrite1h * p.input * 2
  ) / 1e6;
}

// ---- State ----------------------------------------------------------------

const files = new Map();    // path -> { offset, partial }
const seen = new Set();     // message ids already counted (one message spans many lines)
const sessions = new Map(); // sessionId -> session record
const events = [];          // { t, sid, model, input, output, cacheRead, cacheWrite5m, cacheWrite1h, cost }

function sessionFor(id, entry) {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      project: entry.cwd || '',
      branch: entry.gitBranch || '',
      entrypoint: entry.entrypoint || '',
      title: '',
      firstAt: 0,
      lastAt: 0,
      lastModel: '',
      messages: 0,
      subagentMessages: 0,
    };
    sessions.set(id, s);
  }
  if (entry.cwd) s.project = entry.cwd;
  if (entry.gitBranch) s.branch = entry.gitBranch;
  return s;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const t = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    return t ? t.text : '';
  }
  return '';
}

function ingest(entry, filePath) {
  const sid = entry.sessionId || path.basename(filePath, '.jsonl');
  const t = Date.parse(entry.timestamp) || 0;

  if ((entry.type === 'summary' || entry.type === 'ai-title') && sid) {
    const title = entry.summary || entry.title;
    if (title) sessionFor(sid, entry).title = String(title);
    return;
  }

  if (entry.type === 'user' && !entry.isSidechain && !entry.isMeta) {
    const s = sessionFor(sid, entry);
    if (!s.title) {
      const text = textOf(entry.message && entry.message.content).trim();
      if (text && !text.startsWith('<')) s.title = text.replace(/\s+/g, ' ').slice(0, 120);
    }
    if (t && (!s.firstAt || t < s.firstAt)) s.firstAt = t;
    return;
  }

  if (entry.type !== 'assistant' || !entry.message || !entry.message.usage) return;
  const msg = entry.message;
  if (!msg.model || msg.model === '<synthetic>') return;

  const key = msg.id || entry.requestId || entry.uuid;
  if (key) {
    if (seen.has(key)) return;
    seen.add(key);
  }

  const u = msg.usage;
  const cc = u.cache_creation || {};
  const cacheWriteTotal = u.cache_creation_input_tokens || 0;
  const cacheWrite1h = cc.ephemeral_1h_input_tokens || 0;
  const rec = {
    t,
    sid,
    model: msg.model,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite1h,
    cacheWrite5m: Math.max(0, cacheWriteTotal - cacheWrite1h),
  };
  rec.cost = costOf(rec.model, rec);
  events.push(rec);

  const s = sessionFor(sid, entry);
  if (t && (!s.firstAt || t < s.firstAt)) s.firstAt = t;
  if (t > s.lastAt) {
    s.lastAt = t;
    s.lastModel = msg.model;
  }
  if (entry.isSidechain) s.subagentMessages++;
  else s.messages++;
  dirty = true;
}

// ---- File tailing -----------------------------------------------------------

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function rescan() {
  const cutoff = Date.now() - HISTORY_DAYS * 86400e3;
  for (const p of walk(PROJECTS_DIR, [])) {
    if (files.has(p)) continue;
    try {
      if (fs.statSync(p).mtimeMs < cutoff) continue;
    } catch {
      continue;
    }
    files.set(p, { offset: 0, partial: '' });
    readNew(p);
  }
}

function readNew(p) {
  const f = files.get(p);
  let size;
  try {
    size = fs.statSync(p).size;
  } catch {
    files.delete(p);
    return;
  }
  if (size < f.offset) {
    // Rewritten or truncated: re-read from the start; `seen` prevents double counting.
    f.offset = 0;
    f.partial = '';
  }
  if (size === f.offset) return;

  const fd = fs.openSync(p, 'r');
  try {
    const CHUNK = 1 << 20;
    const buf = Buffer.alloc(CHUNK);
    while (f.offset < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - f.offset), f.offset);
      if (n <= 0) break;
      f.offset += n;
      const lines = (f.partial + buf.toString('utf8', 0, n)).split('\n');
      f.partial = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          ingest(JSON.parse(line), p);
        } catch {
          // Skip malformed lines.
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---- Snapshot -----------------------------------------------------------------

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, messages: 0 });

function add(tot, e) {
  tot.input += e.input;
  tot.output += e.output;
  tot.cacheRead += e.cacheRead;
  tot.cacheWrite += e.cacheWrite5m + e.cacheWrite1h;
  tot.total += e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h;
  tot.cost += e.cost;
  tot.messages++;
}

function localDayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function snapshot() {
  const now = Date.now();
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const fiveHoursAgo = now - 5 * 3600e3;
  const activeCutoff = now - ACTIVE_MINUTES * 60e3;
  const MINUTES = 60;
  const minuteStart = Math.floor(now / 60e3) * 60e3 - (MINUTES - 1) * 60e3;

  const totals = { today: emptyTotals(), window5h: emptyTotals(), all: emptyTotals() };
  const perSession = new Map();
  const perMinute = Array.from({ length: MINUTES }, (_, i) => ({ t: minuteStart + i * 60e3, tokens: 0, output: 0, cost: 0 }));
  const perDay = new Map();
  const perModel = new Map();

  for (const e of events) {
    add(totals.all, e);
    if (e.t >= startOfToday) add(totals.today, e);
    if (e.t >= fiveHoursAgo) add(totals.window5h, e);

    let ps = perSession.get(e.sid);
    if (!ps) perSession.set(e.sid, (ps = { totals: emptyTotals(), recent: new Array(30).fill(0), burn5m: 0 }));
    add(ps.totals, e);
    const tokens = e.input + e.output + e.cacheRead + e.cacheWrite5m + e.cacheWrite1h;
    const minutesAgo = Math.floor((now - e.t) / 60e3);
    if (minutesAgo >= 0 && minutesAgo < 30) ps.recent[29 - minutesAgo] += tokens;
    if (minutesAgo >= 0 && minutesAgo < 5) ps.burn5m += tokens;

    const mi = Math.floor((e.t - minuteStart) / 60e3);
    if (mi >= 0 && mi < MINUTES) {
      perMinute[mi].tokens += tokens;
      perMinute[mi].output += e.output;
      perMinute[mi].cost += e.cost;
    }

    const day = localDayKey(e.t);
    let pd = perDay.get(day);
    if (!pd) perDay.set(day, (pd = emptyTotals()));
    add(pd, e);

    let pm = perModel.get(e.model);
    if (!pm) perModel.set(e.model, (pm = emptyTotals()));
    add(pm, e);
  }

  const sessionList = [];
  for (const s of sessions.values()) {
    const ps = perSession.get(s.id);
    if (!ps) continue;
    sessionList.push({
      ...s,
      active: s.lastAt >= activeCutoff,
      totals: ps.totals,
      recent: ps.recent,
      burnPerMin: Math.round(ps.burn5m / 5),
    });
  }
  sessionList.sort((a, b) => b.lastAt - a.lastAt);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() - i);
    const key = localDayKey(d.getTime());
    days.push({ day: key, ...(perDay.get(key) || emptyTotals()) });
  }

  return {
    generatedAt: now,
    source: PROJECTS_DIR,
    activeMinutes: ACTIVE_MINUTES,
    historyDays: HISTORY_DAYS,
    filesWatched: files.size,
    totals,
    perMinute,
    days,
    models: [...perModel.entries()].map(([model, t]) => ({ model, priced: !!priceFor(model), ...t })).sort((a, b) => b.cost - a.cost),
    sessions: sessionList,
  };
}

// ---- HTTP ---------------------------------------------------------------------

let dirty = false;
const clients = new Set();
const dashboard = path.join(__dirname, 'public', 'index.html');

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(dashboard).pipe(res);
  } else if (url.pathname === '/api/snapshot') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(snapshot()));
  } else if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

rescan();
setInterval(() => {
  for (const p of files.keys()) readNew(p);
  if (dirty) {
    dirty = false;
    broadcast();
  }
}, POLL_MS);
setInterval(rescan, RESCAN_MS);
// Refresh anyway so "active" flags, the minute chart and burn rates age out.
setInterval(broadcast, 15000);

server.listen(PORT, HOST, () => {
  console.log(`Claude usage dashboard: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Watching ${PROJECTS_DIR} (${files.size} transcript files, last ${HISTORY_DAYS} days)`);
});
