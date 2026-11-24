// Internship dashboard server — no dependencies, needs Node 18+.
// Run:  node server.js     then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const POLL_MINUTES = Number(process.env.POLL_MINUTES) || 5;
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------------------------------------------------------- sources
// Each source returns an array of normalized jobs:
// { id, source, company, title, locations[], url, posted (ms), tags[] }
const SOURCES = [
  {
    name: "Simplify",
    site: "https://github.com/SimplifyJobs/Summer2027-Internships",
    async fetch() {
      // Only SWE, data science and ML (skips Quant, Product, Hardware)
      const KEEP = ["Software", "Software Engineering", "AI/ML/Data"];
      const r = await get("https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json");
      return JSON.parse(r)
        // the JSON is shared across Simplify's repos; keep what the Summer 2027 list shows
        .filter((j) => j.active && j.is_visible && (j.terms || []).includes("Summer 2027") && KEEP.includes(j.category))
        .map((j) => ({
          id: "simplify:" + j.id,
          source: "Simplify",
          company: j.company_name,
          title: j.title,
          locations: j.locations || [],
          url: j.url,
          posted: j.date_posted * 1000,
          tags: [j.category, j.sponsorship !== "Other" ? j.sponsorship : null].filter(Boolean),
        }));
    },
  },
  {
    name: "Vansh",
    site: "https://github.com/vanshb03/Summer2027-Internships",
    async fetch() {
      const r = await get("https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json");
      return JSON.parse(r)
        .filter((j) => j.active && j.is_visible)
        .map((j) => ({
          id: "vansh:" + j.id,
          source: "Vansh",
          company: j.company_name,
          title: j.title,
          locations: j.locations || [],
          url: j.url,
          posted: j.date_posted * 1000,
          tags: [j.season, j.sponsorship !== "Other" ? j.sponsorship : null].filter(Boolean),
        }));
    },
  },
  {
    name: "Empluzzed",
    site: "https://empluzzed.fyi/internships?role=software",
    async fetch() {
      // Same filter as ?role=software on the site: tags in its "software" family
      const SOFTWARE = ["software-engineering", "ai-ml-engineering", "cloud-infrastructure"];
      const r = JSON.parse(await get("https://empluzzed.fyi/internships.json"));
      return r.jobs
        .filter((j) => (j.roleTags || []).some((t) => SOFTWARE.includes(t)))
        .map((j) => ({
          id: "empluzzed:" + j.id,
          source: "Empluzzed",
          company: j.company,
          title: j.title,
          locations: j.location ? [j.location] : [],
          url: j.applyUrl,
          posted: Date.parse(j.postedAt) || Date.parse(j.firstPublishedAt) || Date.now(),
          tags: [j.term, j.workMode === "remote" ? "Remote" : null, j.salary ? String(j.salary) : null].filter(Boolean),
        }));
    },
  },
];

// ---------------------------------------------------------------- state
// state.firstSeen: id -> timestamp we first saw it. Anything first seen after
// the very first sync is flagged "new".
let state = { firstSeen: {}, baselineAt: null };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
let jobs = [];
const sourceStatus = Object.fromEntries(SOURCES.map((s) => [s.name, { ok: null, count: 0, error: null, site: s.site }]));
let lastSync = null;
let syncing = false;
const clients = new Set();

async function sync() {
  if (syncing) return;
  syncing = true;
  const isBaseline = !state.baselineAt;
  const now = Date.now();
  const fresh = [];
  const byId = new Map(jobs.map((j) => [j.id, j]));

  await Promise.all(SOURCES.map(async (s) => {
    try {
      const list = await s.fetch();
      sourceStatus[s.name] = { ...sourceStatus[s.name], ok: true, count: list.length, error: null };
      for (const j of list) byId.set(j.id, j);
      // drop listings from this source that disappeared (closed)
      const ids = new Set(list.map((j) => j.id));
      for (const [id, j] of byId) if (j.source === s.name && !ids.has(id)) byId.delete(id);
    } catch (e) {
      sourceStatus[s.name] = { ...sourceStatus[s.name], ok: false, error: String(e.message || e) };
      console.error(`[${s.name}] ${e.message || e}`);
    }
  }));

  for (const j of byId.values()) {
    if (!(j.id in state.firstSeen)) {
      state.firstSeen[j.id] = isBaseline ? 0 : now;
      if (!isBaseline) fresh.push(j);
    }
    j.firstSeen = state.firstSeen[j.id];
  }
  if (isBaseline) state.baselineAt = now;

  jobs = [...byId.values()].sort((a, b) => b.posted - a.posted);
  lastSync = now;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  syncing = false;

  console.log(`${new Date().toLocaleTimeString()}  synced ${jobs.length} listings, ${fresh.length} new`);
  broadcast("sync", { lastSync, sources: sourceStatus, total: jobs.length, newJobs: fresh });
}

// ---------------------------------------------------------------- http
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/jobs") {
    return json(res, { lastSync, sources: sourceStatus, baselineAt: state.baselineAt, pollMinutes: POLL_MINUTES, jobs });
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    await sync();
    return json(res, { ok: true });
  }
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 5000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.readFile(file, (err, buf) => {
    if (err) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" }).end(buf);
  });
}).listen(PORT, () => {
  console.log(`Internship dashboard on http://localhost:${PORT}  (checking every ${POLL_MINUTES} min)`);
  sync();
  setInterval(sync, POLL_MINUTES * 60 * 1000);
  setInterval(() => broadcast("ping", {}), 25000);
});

// ---------------------------------------------------------------- helpers
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
}
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": "internship-dashboard" }, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}
