import { mkdir } from "node:fs/promises";

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
