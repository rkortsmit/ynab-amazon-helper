// Local GUI for ynab-amazon-helper.
// Start with:  bun gui/server.ts   (or double-click "Start GUI.bat")
// Listens on 127.0.0.1 only, and every API call must carry a random per-session token,
// so other websites and other computers cannot trigger commands.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(guiDir, "..");
const dataDir = join(rootDir, "data");
const TOKEN = randomBytes(16).toString("hex");
const BASE_PORT = Number(process.env.GUI_PORT ?? 4178);
const noOpen = process.argv.includes("--no-open");

// ---------- command whitelist ----------

type OptSpec =
  | { kind: "int"; flag: string; min: number; max: number }
  | { kind: "enum"; flag: string; values: string[] }
  | { kind: "profile"; flag: string }
  | { kind: "txid"; flag: string }
  | { kind: "category"; flag: string }
  | { kind: "bundle"; flag: string }
  | { kind: "bool"; flag: string }
  | { kind: "splits"; flag: string }
  | { kind: "order"; flag: string };

type CmdSpec = {
  base: string[];
  opts: Record<string, OptSpec>;
  required?: string[];
  canWrite?: boolean;
  needsInput?: boolean; // only commands that wait for Enter get a stdin pipe
};

const COMMANDS: Record<string, CmdSpec> = {
  "ynab-plans": { base: ["ynab", "plans"], opts: {} },
  "ynab-accounts": { base: ["ynab", "accounts"], opts: {} },
  "ynab-categories": { base: ["ynab", "categories"], opts: {} },
  "amazon-sync": {
    base: ["amazon", "sync"],
    opts: { profile: { kind: "profile", flag: "--profile" }, pages: { kind: "int", flag: "--pages", min: 1, max: 50 } },
    required: ["profile"],
    needsInput: true,
  },
  "amazon-open": {
    base: ["amazon", "open"],
    opts: { profile: { kind: "profile", flag: "--profile" }, order: { kind: "order", flag: "--order" }, close: { kind: "bool", flag: "--close" } },
    required: ["profile", "order"],
    needsInput: true,
  },
  learn: { base: ["learn"], opts: { historyDays: { kind: "int", flag: "--history-days", min: 1, max: 3650 } } },
  analyze: {
    base: ["analyze"],
    opts: {
      days: { kind: "int", flag: "--days", min: 1, max: 730 },
      historyDays: { kind: "int", flag: "--history-days", min: 1, max: 3650 },
      unapprovedOnly: { kind: "bool", flag: "--unapproved-only" },
    },
  },
  "reconcile-analyze": {
    base: ["reconcile", "analyze"],
    opts: {
      days: { kind: "int", flag: "--days", min: 1, max: 730 },
      historyDays: { kind: "int", flag: "--history-days", min: 1, max: 3650 },
      unapprovedOnly: { kind: "bool", flag: "--unapproved-only" },
    },
  },
  match: { base: ["match"], opts: { days: { kind: "int", flag: "--days", min: 1, max: 730 } } },
  "memo-apply": {
    base: ["memo", "apply"],
    opts: {
      file: { kind: "bundle", flag: "--file" },
      minConfidence: { kind: "enum", flag: "--min-confidence", values: ["strong", "medium"] },
      transactionId: { kind: "txid", flag: "--transaction-id" },
      limit: { kind: "int", flag: "--limit", min: 1, max: 1000 },
    },
    canWrite: true,
  },
  "memo-backfill": {
    base: ["memo", "backfill"],
    opts: { days: { kind: "int", flag: "--days", min: 1, max: 730 }, overwrite: { kind: "bool", flag: "--overwrite" } },
    canWrite: true,
  },
  decide: {
    base: ["decide"],
    opts: {
      file: { kind: "bundle", flag: "--file" },
      transactionId: { kind: "txid", flag: "--transaction-id" },
      category: { kind: "category", flag: "--category" },
    },
    required: ["transactionId", "category"],
  },
  remember: {
    base: ["remember"],
    opts: {
      file: { kind: "bundle", flag: "--file" },
      transactionId: { kind: "txid", flag: "--transaction-id" },
      category: { kind: "category", flag: "--category" },
      scope: { kind: "enum", flag: "--scope", values: ["item", "fingerprint", "both"] },
    },
    required: ["transactionId", "category"],
  },
  split: {
    base: ["split"],
    opts: {
      file: { kind: "bundle", flag: "--file" },
      transactionId: { kind: "txid", flag: "--transaction-id" },
      splits: { kind: "splits", flag: "--splits" },
      clear: { kind: "bool", flag: "--clear" },
    },
    required: ["transactionId"],
  },
  apply: {
    base: ["apply"],
    opts: { file: { kind: "bundle", flag: "--file" }, onlyDecided: { kind: "bool", flag: "--only-decided" } },
    canWrite: true,
  },
  "reconcile-apply": { base: ["reconcile", "apply"], opts: { onlyDecided: { kind: "bool", flag: "--only-decided" } }, canWrite: true },
};

const LABELS: Record<string, string> = { transactionId: "Transaction ID", category: "Category", profile: "Profile", order: "Order number" };

const BUNDLES: Record<string, string> = {
  analysis: "data/analysis-latest.json",
  reconcile: "data/reconcile-latest.json",
};

function buildArgs(id: string, values: Record<string, unknown>, write: boolean): string[] {
  const spec = COMMANDS[id];
  if (!spec) throw new Error(`Unknown command: ${id}`);
  const args = [...spec.base];

  for (const [key, opt] of Object.entries(spec.opts)) {
    const raw = values[key];
    const empty = raw === undefined || raw === null || raw === "" || raw === false;
    if (empty) {
      if (spec.required?.includes(key)) throw new Error(`Fill in ${LABELS[key] ?? key} to run this.`);
      continue;
    }
    const text = String(raw).trim();
    switch (opt.kind) {
      case "int": {
        const n = Number(text);
        if (!Number.isInteger(n) || n < opt.min || n > opt.max) throw new Error(`"${key}" must be a whole number ${opt.min}-${opt.max}.`);
        args.push(opt.flag, String(n));
        break;
      }
      case "enum":
        if (!opt.values.includes(text)) throw new Error(`"${key}" must be one of ${opt.values.join(", ")}.`);
        args.push(opt.flag, text);
        break;
      case "profile":
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(text)) throw new Error("Profile may only use letters, numbers, - and _.");
        args.push(opt.flag, text);
        break;
      case "txid":
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) throw new Error("Transaction id looks invalid.");
        args.push(opt.flag, text);
        break;
      case "category":
        if (text.length > 120 || text.startsWith("-")) throw new Error("Category name looks invalid.");
        args.push(opt.flag, text);
        break;
      case "bundle":
        if (!BUNDLES[text]) throw new Error("Unknown analysis file.");
        args.push(opt.flag, BUNDLES[text]);
        break;
      case "bool":
        if (raw === true) args.push(opt.flag);
        break;
      case "order":
        if (!/^[0-9A-Za-z-]{5,40}$/.test(text)) throw new Error("Order number looks invalid.");
        args.push(opt.flag, text);
        break;
      case "splits": {
        // Re-serialize only the expected fields so nothing else can ride along.
        const list = Array.isArray(raw) ? raw : null;
        if (!list || list.length < 2 || list.length > 30) throw new Error("A split needs between 2 and 30 lines.");
        const clean = list.map((line: any, i: number) => {
          const cents = Number(line?.amountCents);
          const category = String(line?.category ?? "").trim();
          const memo = String(line?.memo ?? "").trim().slice(0, 100);
          if (!Number.isInteger(cents) || cents <= 0) throw new Error(`Split line ${i + 1}: amount must be more than $0.00.`);
          if (!category || category.length > 120 || category.startsWith("-")) throw new Error(`Split line ${i + 1}: pick a category.`);
          return { category, amountCents: cents, memo };
        });
        args.push(opt.flag, JSON.stringify(clean));
        break;
      }
    }
  }

  if (write) {
    if (!spec.canWrite) throw new Error("This command has no write mode.");
    args.push("--write");
  }
  return args;
}

// ---------- job runner (one command at a time) ----------

type Job = { id: number; cmdline: string; output: string; running: boolean; exitCode: number | null; child: ChildProcess | null };
let job: Job | null = null;
let nextJobId = 1;

// Environment for child processes. Settings from .env are left out so each command reads the
// current .env file (it may have just been changed on the Setup tab).
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const key of Object.keys(env)) if (/^(YNAB_|AMAZON_MARKETPLACE$)/.test(key)) delete env[key];
  return env;
}

function startJob(args: string[], needsInput: boolean, raw?: { argv: string[]; label: string }): Job {
  if (job?.running) throw new Error("Another command is still running. Stop it or wait for it to finish.");
  // process.execPath is bun.exe when started with bun; execArgv carries any runtime flags.
  const argv = raw ? raw.argv : [...process.execArgv, "src/index.ts", ...args];
  const child = spawn(process.execPath, argv, {
    cwd: rootDir,
    env: childEnv(),
    stdio: [needsInput ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const j: Job = { id: nextJobId++, cmdline: raw ? raw.label : `bun run start ${args.map(quote).join(" ")}`, output: "", running: true, exitCode: null, child };
  const append = (chunk: Buffer) => {
    j.output += chunk.toString("utf8");
    if (j.output.length > 2_000_000) j.output = j.output.slice(-1_500_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (err) => {
    j.output += `\n[could not start: ${err.message}]\n`;
    j.running = false;
    j.exitCode = -1;
  });
  child.on("close", (code) => {
    j.running = false;
    j.exitCode = code ?? -1;
    j.child = null;
  });
  job = j;
  return j;
}

function quote(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

// ---------- status + bundle readers ----------

function readEnvFile(): Record<string, string> {
  const path = join(rootDir, ".env");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// ---------- setup ----------

let browserCheck: { at: number; installed: boolean } | null = null;
async function browserInstalled(): Promise<boolean> {
  if (browserCheck && Date.now() - browserCheck.at < 5_000) return browserCheck.installed;
  let installed = false;
  try {
    const pw: any = await import(join(rootDir, "node_modules", "playwright", "index.js"));
    const path = (pw.chromium ?? pw.default?.chromium)?.executablePath?.();
    installed = Boolean(path) && existsSync(path);
  } catch {
    installed = false;
  }
  browserCheck = { at: Date.now(), installed };
  return installed;
}

async function setupStatus() {
  const env = readEnvFile();
  const s = status();
  const depsInstalled = existsSync(join(rootDir, "node_modules", "playwright"));
  return {
    runtime: (process.versions as any).bun ? `Bun ${(process.versions as any).bun}` : `Node ${process.versions.node}`,
    depsInstalled,
    browserInstalled: depsInstalled ? await browserInstalled() : false,
    envFile: s.envFile,
    tokenSet: s.tokenSet,
    planId: env.YNAB_PLAN_ID || "last-used",
    accountName: env.YNAB_ACCOUNT_NAME || null,
    profiles: s.profiles.length,
    configured: s.tokenSet && Boolean(env.YNAB_ACCOUNT_NAME),
  };
}

function tokenFrom(body: any): string {
  const given = String(body?.token ?? "").trim();
  const token = given || (readEnvFile().YNAB_ACCESS_TOKEN ?? "").trim();
  if (!token) throw new Error("Paste your YNAB personal access token first.");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error("That doesn't look like a YNAB token. It should be one long string of letters, numbers, - and _.");
  return token;
}

async function ynabGet(token: string, path: string): Promise<any> {
  const res = await fetch(`https://api.ynab.com/v1${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (res.status === 401) throw new Error("YNAB didn't accept that token. Check that you copied all of it, or create a new one.");
  if (!res.ok) throw new Error(`YNAB request failed (${res.status}).`);
  return (await res.json()).data;
}

function saveEnv(values: Record<string, string>) {
  const path = join(rootDir, ".env");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const done = new Set<string>();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${v}`);
  if (!out.some((l) => /^\s*AMAZON_MARKETPLACE\s*=/.test(l))) out.push("AMAZON_MARKETPLACE=https://www.amazon.com");
  writeFileSync(path, out.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n", "utf8");
}

function fileInfo(rel: string) {
  const p = join(rootDir, rel);
  return existsSync(p) ? { exists: true, modified: statSync(p).mtime.toISOString() } : { exists: false, modified: null };
}

function status() {
  const env = readEnvFile();
  // Profiles = saved Amazon logins (profiles/<name>) plus any synced order files (data/amazon-orders-<slug>.json).
  const slug = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const names = new Map<string, string>();
  const profilesDir = join(rootDir, "profiles");
  if (existsSync(profilesDir)) {
    for (const e of readdirSync(profilesDir, { withFileTypes: true })) {
      if (e.isDirectory() && /^[A-Za-z0-9_-]{1,32}$/.test(e.name)) names.set(slug(e.name), e.name);
    }
  }
  if (existsSync(dataDir)) {
    for (const f of readdirSync(dataDir)) {
      const m = f.match(/^amazon-orders-(.+)\.json$/);
      if (m && !names.has(m[1])) names.set(m[1], m[1]);
    }
  }
  const profiles = [...names.entries()]
    .map(([s, name]) => ({ name, ...fileInfo(`data/amazon-orders-${s}.json`) }))
    .sort((a, b) => (a.name.toLowerCase() === "primary" ? -1 : b.name.toLowerCase() === "primary" ? 1 : a.name.localeCompare(b.name)));
  return {
    envFile: existsSync(join(rootDir, ".env")),
    tokenSet: Boolean((env.YNAB_ACCESS_TOKEN ?? "").trim()),
    accountName: env.YNAB_ACCOUNT_NAME || null,
    planId: env.YNAB_PLAN_ID || "last-used",
    profiles,
    analysis: fileInfo(BUNDLES.analysis),
    reconcile: fileInfo(BUNDLES.reconcile),
    memory: fileInfo("data/category-memory.json"),
    running: job?.running ?? false,
  };
}

function bundle(which: string) {
  const rel = BUNDLES[which];
  if (!rel) throw new Error("Unknown analysis file.");
  const p = join(rootDir, rel);
  if (!existsSync(p)) return { exists: false };
  const b = JSON.parse(readFileSync(p, "utf8"));
  let priceStore: Record<string, any> = {};
  try {
    const pp = join(dataDir, "amazon-item-prices.json");
    if (existsSync(pp)) priceStore = JSON.parse(readFileSync(pp, "utf8"));
  } catch {
    priceStore = {};
  }
  const pricesFor = (order: any) => {
    const saved = order?.orderNumber ? priceStore[order.orderNumber] : null;
    const src = saved?.items?.length ? { items: saved.items, summary: saved.summary } : order?.items?.length ? { items: order.items, summary: order.costSummary ?? null } : null;
    if (!src) return null;
    return {
      items: src.items.map((i: any) => ({ title: String(i.title ?? ""), unitCents: typeof i.unitPriceCents === "number" ? i.unitPriceCents : null, qty: Number(i.quantity) || 1 })),
      subtotalCents: src.summary?.subtotalCents ?? null,
      shippingCents: src.summary?.shippingCents ?? null,
      taxCents: src.summary?.taxCents ?? null,
      totalCents: src.summary?.totalCents ?? null,
    };
  };
  const transactions = (b.transactions ?? []).map((t: any) => ({
    id: t.transactionId,
    date: t.transactionDate,
    amount: (t.signedAmountCents ?? t.amountCents) / 100,
    payee: t.payee,
    account: t.accountName,
    memo: t.memo,
    workflow: t.workflow,
    approvedInYnab: t.approvedInYnab === true,
    status: t.decision?.status,
    proposed: t.decision?.proposedCategoryName ?? null,
    selected: t.decision?.selectedCategoryName ?? null,
    confidence: t.bestMatch?.confidence ?? null,
    ambiguous: Boolean(t.ambiguous),
    dayDelta: t.bestMatch?.dayDelta ?? null,
    items: t.bestMatch?.order?.itemTitles ?? [],
    orderUrl: typeof t.bestMatch?.order?.detailUrl === "string" && t.bestMatch.order.detailUrl.startsWith("https://www.amazon.") ? t.bestMatch.order.detailUrl : null,
    splits: Array.isArray(t.decision?.splits) ? t.decision.splits.map((l: any) => ({ category: l.categoryName, amount: l.amountCents / 100, memo: l.memo })) : null,
    orderNumber: t.bestMatch?.order?.orderNumber ?? null,
    prices: pricesFor(t.bestMatch?.order),
    profile: t.bestMatch?.order?.profile ?? null,
  }));
  const categories = (b.categories ?? [])
    .filter((c: any) => !c.deleted && !c.hidden)
    .map((c: any) => ({ id: c.id, name: c.name, group: c.groupName }));
  return { exists: true, modified: statSync(p).mtime.toISOString(), summary: b.summary, transactions, categories };
}

// ---------- http ----------

function send(res: ServerResponse, code: number, body: unknown, type = "application/json; charset=utf-8") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Request too large.");
  }
  return body ? JSON.parse(body) : {};
}

function handler(port: number) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, readFileSync(join(guiDir, "index.html"), "utf8"), "text/html; charset=utf-8");
      }

      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });
      if (req.headers["x-token"] !== TOKEN) return send(res, 403, { error: "Missing or wrong session token. Reopen the GUI from the launcher." });

      if (req.method === "GET" && url.pathname === "/api/status") return send(res, 200, status());
      if (req.method === "GET" && url.pathname === "/api/bundle") return send(res, 200, bundle(url.searchParams.get("file") ?? "analysis"));

      if (req.method === "GET" && url.pathname === "/api/job") {
        if (!job) return send(res, 200, { id: null });
        const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
        const tail = job.output.slice(-400);
        return send(res, 200, {
          id: job.id,
          cmdline: job.cmdline,
          output: job.output.slice(since),
          next: job.output.length,
          running: job.running,
          exitCode: job.exitCode,
          waitingForEnter: job.running && /Press Enter/i.test(tail.split(/\n/).slice(-3).join("\n")),
        });
      }

      if (req.method === "GET" && url.pathname === "/api/setup/status") return send(res, 200, await setupStatus());

      if (req.method === "POST" && url.pathname === "/api/setup/plans") {
        const token = tokenFrom(await readJson(req));
        const data = await ynabGet(token, "/plans");
        const plans = (data.plans ?? data.budgets ?? []).map((p: any) => ({ id: p.id, name: p.name, lastModified: p.last_modified_on ?? null }));
        return send(res, 200, { plans });
      }

      if (req.method === "POST" && url.pathname === "/api/setup/accounts") {
        const body = await readJson(req);
        const token = tokenFrom(body);
        const planId = String(body.planId ?? "last-used");
        if (!/^(last-used|default|[0-9a-f-]{36})$/.test(planId)) throw new Error("Pick a budget first.");
        const data = await ynabGet(token, `/plans/${planId}/accounts`);
        const accounts = (data.accounts ?? [])
          .filter((a: any) => !a.deleted && !a.closed)
          .map((a: any) => ({ id: a.id, name: a.name, type: a.type, onBudget: a.on_budget !== false }));
        return send(res, 200, { accounts });
      }

      if (req.method === "POST" && url.pathname === "/api/setup/save") {
        const body = await readJson(req);
        const token = tokenFrom(body);
        const planId = String(body.planId ?? "last-used");
        const accountName = String(body.accountName ?? "").trim();
        if (!/^(last-used|default|[0-9a-f-]{36})$/.test(planId)) throw new Error("Pick a budget first.");
        if (!accountName || accountName.length > 120 || /[\r\n=]/.test(accountName)) throw new Error("Pick the credit card account you use for Amazon.");
        // Check the account really exists in that budget before saving.
        const data = await ynabGet(token, `/plans/${planId}/accounts`);
        if (!(data.accounts ?? []).some((a: any) => a.name === accountName)) throw new Error("That account wasn't found in the chosen budget.");
        saveEnv({ YNAB_ACCESS_TOKEN: token, YNAB_PLAN_ID: planId, YNAB_ACCOUNT_NAME: accountName });
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/setup/install") {
        const body = await readJson(req);
        const what = String(body.what ?? "");
        const raw =
          what === "deps" ? { argv: ["install"], label: "bun install" }
          : what === "browser" ? { argv: ["x", "playwright", "install", "chromium"], label: "bunx playwright install chromium" }
          : null;
        if (!raw) throw new Error("Unknown setup step.");
        if (!(process.versions as any).bun) throw new Error("Setup installs need the GUI to be started with Bun (use the Start GUI launcher).");
        browserCheck = null;
        const j = startJob([], false, raw);
        return send(res, 200, { id: j.id, cmdline: j.cmdline });
      }

      if (req.method === "POST" && url.pathname === "/api/run") {
        const body = await readJson(req);
        const id = String(body.command ?? "");
        const args = buildArgs(id, body.values ?? {}, body.write === true);
        const j = startJob(args, COMMANDS[id]?.needsInput === true);
        return send(res, 200, { id: j.id, cmdline: j.cmdline });
      }

      if (req.method === "POST" && url.pathname === "/api/preview") {
        const body = await readJson(req);
        const args = buildArgs(String(body.command ?? ""), body.values ?? {}, body.write === true);
        return send(res, 200, { cmdline: `bun run start ${args.map(quote).join(" ")}` });
      }

      if (req.method === "POST" && url.pathname === "/api/enter") {
        if (!job?.running || !job.child?.stdin) return send(res, 400, { error: "Nothing is waiting for input." });
        job.child.stdin.write("\n");
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/stop") {
        if (job?.running && job.child) {
          job.child.kill();
          job.output += "\n[stopped by you]\n";
        }
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: "Not found." });
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

function openBrowser(url: string) {
  if (noOpen) return;
  const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function listen(port: number, triesLeft: number) {
  const server = createServer(handler(port));
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error(err.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/?t=${TOKEN}`;
    console.log("YNAB Amazon Helper GUI is running.");
    console.log(`Open: ${url}`);
    console.log("Leave this window open while you use the GUI. Close it to stop.");
    openBrowser(url);
  });
}

listen(BASE_PORT, 10);
