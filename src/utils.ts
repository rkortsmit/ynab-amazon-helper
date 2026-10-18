import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function centsToCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function milliunitsToCents(milliunits: number): number {
  return Math.round(milliunits / 10);
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function normalizeTitle(value: string | null | undefined): string {
  return normalizeText(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMoneyToCents(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const match = value.replace(/,/g, "").match(/(-?)\$?\s*(\d+)(?:\.(\d{2}))?/);
  if (!match) {
    return null;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const dollars = Number(match[2]);
  const cents = Number(match[3] ?? "0");
  return sign * (dollars * 100 + cents);
}

export function parseUsDateToIso(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(`${value} 12:00:00 UTC`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function daysBetween(dateA: string, dateB: string): number | null {
  const a = new Date(`${dateA}T00:00:00Z`);
  const b = new Date(`${dateB}T00:00:00Z`);

  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) {
    return null;
  }

  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

// Writes a file so a crash or a second process can never leave it half-written: the text goes to a
// temporary file first and is then renamed over the real one. Windows can briefly refuse the rename
// while an antivirus scan or another program has the old file open, so it retries a few times.
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, contents, "utf8");

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}

// Reads a JSON file. A missing file gives null. A file that exists but isn't valid JSON is renamed to
// "<name>.corrupt-<timestamp>" (so nothing is lost) and also gives null. Any other read problem is
// thrown, because treating "couldn't read it" as "empty" is how a later save wipes good data.
export async function readJsonFile<T>(path: string): Promise<T | null> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return JSON.parse(contents) as T;
  } catch {
    const saved = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await rename(path, saved).catch(() => {});
    console.error(`${path} could not be read as JSON. The unreadable copy was kept as ${saved}.`);
    return null;
  }
}
