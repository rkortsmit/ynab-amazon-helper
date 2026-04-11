import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import type { AmazonOrder, AmazonOrderCache } from "./types.ts";
import { slugify } from "./utils.ts";

function profileCachePath(config: AppConfig, profile: string): string {
  return join(config.dataDir, `amazon-orders-${slugify(profile)}.json`);
}

function cacheKey(order: AmazonOrder): string {
  if (order.orderNumber) {
    return [order.profile, order.orderNumber].join("::");
  }

  return [order.profile, order.detailUrl].join("::");
}

export async function readProfileOrders(config: AppConfig, profile: string): Promise<AmazonOrder[]> {
  const path = profileCachePath(config, profile);

  try {
    const contents = await readFile(path, "utf8");
    const parsed = JSON.parse(contents) as AmazonOrderCache;
    return parsed.orders ?? [];
  } catch {
    return [];
  }
}

export async function writeProfileOrders(
  config: AppConfig,
  profile: string,
  marketplace: string,
  incomingOrders: AmazonOrder[],
): Promise<{ total: number; added: number; updated: number }> {
  const existingOrders = await readProfileOrders(config, profile);
  const byKey = new Map(existingOrders.map((order) => [cacheKey(order), order]));
  let added = 0;
  let updated = 0;

  for (const order of incomingOrders) {
    const key = cacheKey(order);
    if (byKey.has(key)) {
      updated += 1;
    } else {
      added += 1;
    }
    byKey.set(key, order);
  }

  const merged = [...byKey.values()].sort((left, right) => {
    const leftDate = left.orderDate ?? "";
    const rightDate = right.orderDate ?? "";
    return rightDate.localeCompare(leftDate);
  });

  const payload: AmazonOrderCache = {
    version: 1,
    profile,
    marketplace,
    updatedAt: new Date().toISOString(),
    orders: merged,
  };

  await writeFile(profileCachePath(config, profile), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    total: merged.length,
    added,
    updated,
  };
}

export async function readAllOrders(config: AppConfig): Promise<AmazonOrder[]> {
  const entries = await readdir(config.dataDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("amazon-orders-") && entry.name.endsWith(".json"))
    .map((entry) => join(config.dataDir, entry.name));

  const all: AmazonOrder[] = [];
  for (const file of files) {
    try {
      const contents = await readFile(file, "utf8");
      const parsed = JSON.parse(contents) as AmazonOrderCache;
      all.push(...(parsed.orders ?? []));
    } catch {
      // Ignore malformed cache files and continue with the rest.
    }
  }

  return all;
}
