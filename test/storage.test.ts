import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfileOrders, readProfilePaymentTransactions, writeProfileOrders, writeProfilePaymentTransactions } from "../src/cache.ts";
import type { AppConfig } from "../src/config.ts";
import { addOverrideRule, readMemory } from "../src/memory.ts";
import type { AmazonOrder, AmazonPaymentTransaction } from "../src/types.ts";
import { readJsonFile, writeFileAtomic } from "../src/utils.ts";

let dir: string;
let config: AppConfig;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ynab-helper-test-"));
  config = { rootDir: dir, dataDir: dir, profilesDir: dir } as AppConfig;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function order(orderNumber: string): AmazonOrder {
  return {
    profile: "you",
    marketplace: "https://www.amazon.com",
    detailUrl: `https://www.amazon.com/order/${orderNumber}`,
    orderNumber,
    orderDate: "2026-04-08",
    orderTotalCents: 1000,
    chargeAmountsCents: [1000],
    itemTitles: ["Thing"],
    paymentLast4: [],
    rawPreview: "",
    scrapedAt: "2026-04-10T00:00:00.000Z",
  };
}

function payment(overrides: Partial<AmazonPaymentTransaction>): AmazonPaymentTransaction {
  return {
    profile: "you",
    marketplace: "https://www.amazon.com",
    transactionDate: "2026-10-10",
    transactionStatus: "completed",
    paymentInstrument: "Prime Visa ****9178",
    paymentLast4: "9178",
    amountCents: -4279,
    orderNumber: "111-3288478-5597843",
    merchant: "AMZN Mktp US",
    kind: "charge",
    rawPreview: "",
    scrapedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("writeFileAtomic", () => {
  test("replaces the file and leaves no temporary files behind", async () => {
    const path = join(dir, "data.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two");
    expect(await readFile(path, "utf8")).toBe("two");
    expect(await readdir(dir)).toEqual(["data.json"]);
  });
});

describe("readJsonFile", () => {
  test("returns null for a missing file", async () => {
    expect(await readJsonFile(join(dir, "missing.json"))).toBeNull();
  });

  test("keeps an unreadable file under a new name instead of losing it", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, '{"half": ', "utf8");
    expect(await readJsonFile(path)).toBeNull();
    const files = await readdir(dir);
    const saved = files.find((name) => name.startsWith("broken.json.corrupt-"));
    expect(saved).toBeDefined();
    expect(await readFile(join(dir, saved as string), "utf8")).toBe('{"half": ');
    expect(files).not.toContain("broken.json");
  });
});

describe("caches and memory", () => {
  test("a damaged orders cache is kept aside and the new sync is still saved", async () => {
    await writeFile(join(dir, "amazon-orders-you.json"), "not json", "utf8");
    const summary = await writeProfileOrders(config, "you", "https://www.amazon.com", [order("111-0000000-0000001")]);
    expect(summary.total).toBe(1);
    expect((await readProfileOrders(config, "you")).length).toBe(1);
    expect((await readdir(dir)).some((name) => name.startsWith("amazon-orders-you.json.corrupt-"))).toBe(true);
  });

  test("new orders are merged into an existing cache", async () => {
    await writeProfileOrders(config, "you", "https://www.amazon.com", [order("111-0000000-0000001")]);
    const summary = await writeProfileOrders(config, "you", "https://www.amazon.com", [order("111-0000000-0000002")]);
    expect(summary).toEqual({ total: 2, added: 1, updated: 0 });
  });

  test("a damaged memory file is kept aside, not silently replaced", async () => {
    await writeFile(join(dir, "category-memory.json"), "garbage", "utf8");
    expect(await readMemory(config)).toBeNull();
    expect((await readdir(dir)).some((name) => name.startsWith("category-memory.json.corrupt-"))).toBe(true);
  });

  test("override rules reject empty match text", async () => {
    const base = { categoryId: "c1", categoryName: "Household" };
    await expect(addOverrideRule(config, { ...base, type: "contains_title", match: "   " })).rejects.toThrow();
    await expect(addOverrideRule(config, { ...base, type: "exact_item", match: "!!!" })).rejects.toThrow();
    const rule = await addOverrideRule(config, { ...base, type: "contains_title", match: "Paper Towels" });
    expect(rule.normalizedMatch).toBe("paper towels");
  });
});

describe("payments cache", () => {
  test("the same charge worded differently by two page layouts is saved once", async () => {
    await writeProfilePaymentTransactions(config, "you", "https://www.amazon.com", [payment({})]);
    const summary = await writeProfilePaymentTransactions(config, "you", "https://www.amazon.com", [
      payment({ paymentInstrument: "Prime Visa\u2022\u2022\u2022\u20229178", scrapedAt: "2026-10-21T00:00:00.000Z" }),
    ]);

    expect(summary).toMatchObject({ total: 1, added: 0, updated: 1 });
    const saved = await readProfilePaymentTransactions(config, "you");
    expect(saved).toHaveLength(1);
    expect(saved[0].scrapedAt).toBe("2026-10-21T00:00:00.000Z");
  });

  test("charges that differ in card or amount stay separate", async () => {
    const summary = await writeProfilePaymentTransactions(config, "you", "https://www.amazon.com", [
      payment({}),
      payment({ paymentLast4: null, paymentInstrument: "Amazon Chase Co-Branded Credit Card Rewards" }),
      payment({ amountCents: -100 }),
    ]);

    expect(summary.total).toBe(3);
  });
});
