import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import type { AmazonOrder, AmazonOrderCache, AmazonPaymentTransaction, AmazonPaymentTransactionCache } from "./types.ts";
import { slugify } from "./utils.ts";

function profileCachePath(config: AppConfig, profile: string): string {
  return join(config.dataDir, `amazon-orders-${slugify(profile)}.json`);
}

function paymentTransactionCachePath(config: AppConfig, profile: string): string {
  return join(config.dataDir, `amazon-payments-${slugify(profile)}.json`);
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

export async function readProfilePaymentTransactions(
  config: AppConfig,
  profile: string,
): Promise<AmazonPaymentTransaction[]> {
  const path = paymentTransactionCachePath(config, profile);

  try {
    const contents = await readFile(path, "utf8");
    const parsed = JSON.parse(contents) as AmazonPaymentTransactionCache;
    return parsed.transactions ?? [];
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

function paymentCacheKey(transaction: AmazonPaymentTransaction): string {
  return [
    transaction.profile,
    transaction.orderNumber ?? "(no-order)",
    transaction.transactionDate ?? "(no-date)",
    String(transaction.amountCents),
    transaction.paymentInstrument ?? "(no-instrument)",
    transaction.transactionStatus,
  ].join("::");
}

export async function writeProfilePaymentTransactions(
  config: AppConfig,
  profile: string,
  marketplace: string,
  incomingTransactions: AmazonPaymentTransaction[],
): Promise<{ total: number; added: number; updated: number }> {
  const existingTransactions = await readProfilePaymentTransactions(config, profile);
  const byKey = new Map(existingTransactions.map((transaction) => [paymentCacheKey(transaction), transaction]));
  let added = 0;
  let updated = 0;

  for (const transaction of incomingTransactions) {
    const key = paymentCacheKey(transaction);
    if (byKey.has(key)) {
      updated += 1;
    } else {
      added += 1;
    }
    byKey.set(key, transaction);
  }

  const merged = [...byKey.values()].sort((left, right) => {
    const leftDate = left.transactionDate ?? "";
    const rightDate = right.transactionDate ?? "";
    if (rightDate !== leftDate) {
      return rightDate.localeCompare(leftDate);
    }

    return Math.abs(right.amountCents) - Math.abs(left.amountCents);
  });

  const payload: AmazonPaymentTransactionCache = {
    version: 1,
    profile,
    marketplace,
    updatedAt: new Date().toISOString(),
    transactions: merged,
  };

  await writeFile(paymentTransactionCachePath(config, profile), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

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

export async function readAllPaymentTransactions(config: AppConfig): Promise<AmazonPaymentTransaction[]> {
  const entries = await readdir(config.dataDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("amazon-payments-") && entry.name.endsWith(".json"))
    .map((entry) => join(config.dataDir, entry.name));

  const all: AmazonPaymentTransaction[] = [];
  for (const file of files) {
    try {
      const contents = await readFile(file, "utf8");
      const parsed = JSON.parse(contents) as AmazonPaymentTransactionCache;
      all.push(...(parsed.transactions ?? []));
    } catch {
      // Ignore malformed cache files and continue with the rest.
    }
  }

  return all;
}
