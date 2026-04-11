import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import type {
  HistoryExample,
  LearnedCategoryCount,
  LearnedRule,
  MatchCandidate,
  MemoryStore,
  ManualOverrideRule,
  TransactionMatch,
} from "./types.ts";
import { normalizeText, normalizeTitle } from "./utils.ts";

function memoryPath(config: AppConfig): string {
  return join(config.dataDir, "category-memory.json");
}

function emptyOverrides(): MemoryStore["overrides"] {
  return {
    containsTitleRules: [],
    exactItemRules: [],
    exactFingerprintRules: [],
  };
}

function emptyMemoryStore(): MemoryStore {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: {
      sinceDate: "",
      historyTransactions: 0,
      matchedTransactions: 0,
      cachedOrders: 0,
    },
    overrides: emptyOverrides(),
    learned: {
      exactItemRules: [],
      exactFingerprintRules: [],
    },
    historyExamples: [],
  };
}

export async function readMemory(config: AppConfig): Promise<MemoryStore | null> {
  try {
    const contents = await readFile(memoryPath(config), "utf8");
    return JSON.parse(contents) as MemoryStore;
  } catch {
    return null;
  }
}

export async function writeMemory(config: AppConfig, memory: MemoryStore): Promise<void> {
  await writeFile(memoryPath(config), `${JSON.stringify(memory, null, 2)}\n`, "utf8");
}

export function fingerprintOrder(candidate: MatchCandidate | null): string | null {
  if (!candidate) {
    return null;
  }

  const normalized = candidate.order.itemTitles
    .map((item) => normalizeTitle(item))
    .filter(Boolean)
    .sort();

  if (normalized.length === 0) {
    return null;
  }

  return normalized.join(" | ");
}

function toHistoryExample(match: TransactionMatch): HistoryExample | null {
  if (!match.best || match.ambiguous || !match.transaction.categoryId || !match.transaction.categoryName) {
    return null;
  }

  return {
    transactionId: match.transaction.id,
    transactionDate: match.transaction.date,
    amountCents: Math.abs(match.transaction.amountCents),
    categoryId: match.transaction.categoryId,
    categoryName: match.transaction.categoryName,
    matchConfidence: match.best.confidence,
    orderNumber: match.best.order.orderNumber,
    profile: match.best.order.profile,
    fingerprint: fingerprintOrder(match.best),
    itemTitles: match.best.order.itemTitles,
  };
}

type CategoryCounter = Map<
  string,
  {
    categoryId: string;
    categoryName: string;
    count: number;
    lastSeen: string;
  }
>;

function accumulate(
  counterMap: Map<string, CategoryCounter>,
  key: string,
  categoryId: string,
  categoryName: string,
  transactionDate: string,
): void {
  if (!key) {
    return;
  }

  let categoryCounts = counterMap.get(key);
  if (!categoryCounts) {
    categoryCounts = new Map();
    counterMap.set(key, categoryCounts);
  }

  const existing = categoryCounts.get(categoryId);
  if (existing) {
    existing.count += 1;
    if (transactionDate > existing.lastSeen) {
      existing.lastSeen = transactionDate;
    }
    return;
  }

  categoryCounts.set(categoryId, {
    categoryId,
    categoryName,
    count: 1,
    lastSeen: transactionDate,
  });
}

function counterMapToRules(counterMap: Map<string, CategoryCounter>): LearnedRule[] {
  return [...counterMap.entries()]
    .map(([key, categoryCounts]) => {
      const categories: LearnedCategoryCount[] = [...categoryCounts.values()].sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count;
        }

        return right.lastSeen.localeCompare(left.lastSeen);
      });

      const top = categories[0] ?? null;
      const totalExamples = categories.reduce((sum, category) => sum + category.count, 0);

      return {
        key,
        topCategoryId: top?.categoryId ?? null,
        topCategoryName: top?.categoryName ?? null,
        topCount: top?.count ?? 0,
        totalExamples,
        uniqueCategories: categories.length,
        categories,
      } satisfies LearnedRule;
    })
    .sort((left, right) => {
      if (right.topCount !== left.topCount) {
        return right.topCount - left.topCount;
      }

      return right.totalExamples - left.totalExamples;
    });
}

export function buildMemoryStore(input: {
  historyMatches: TransactionMatch[];
  sinceDate: string;
  cachedOrders: number;
  existingMemory?: MemoryStore | null;
}): MemoryStore {
  const historyExamples = input.historyMatches.map(toHistoryExample).filter((example): example is HistoryExample => example !== null);
  const exactItemCounters = new Map<string, CategoryCounter>();
  const exactFingerprintCounters = new Map<string, CategoryCounter>();

  for (const example of historyExamples) {
    if (example.fingerprint) {
      accumulate(
        exactFingerprintCounters,
        example.fingerprint,
        example.categoryId,
        example.categoryName,
        example.transactionDate,
      );
    }

    for (const item of example.itemTitles.map((title) => normalizeTitle(title)).filter(Boolean)) {
      accumulate(exactItemCounters, item, example.categoryId, example.categoryName, example.transactionDate);
    }
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: {
      sinceDate: input.sinceDate,
      historyTransactions: input.historyMatches.length,
      matchedTransactions: historyExamples.length,
      cachedOrders: input.cachedOrders,
    },
    overrides: input.existingMemory?.overrides ?? emptyOverrides(),
    learned: {
      exactItemRules: counterMapToRules(exactItemCounters),
      exactFingerprintRules: counterMapToRules(exactFingerprintCounters),
    },
    historyExamples,
  };
}

export function getLearnedRule(rules: LearnedRule[], key: string | null): LearnedRule | null {
  if (!key) {
    return null;
  }

  return rules.find((rule) => rule.key === key) ?? null;
}

function normalizeOverrideMatch(type: ManualOverrideRule["type"], match: string): string {
  if (type === "contains_title") {
    return normalizeText(match);
  }

  return normalizeTitle(match);
}

function overridesForType(memory: MemoryStore, type: ManualOverrideRule["type"]): ManualOverrideRule[] {
  switch (type) {
    case "contains_title":
      return memory.overrides.containsTitleRules;
    case "exact_item":
      return memory.overrides.exactItemRules;
    case "exact_fingerprint":
      return memory.overrides.exactFingerprintRules;
  }
}

export async function addOverrideRule(
  config: AppConfig,
  input: {
    type: ManualOverrideRule["type"];
    match: string;
    categoryId: string;
    categoryName: string;
    note?: string | null;
  },
): Promise<ManualOverrideRule> {
  const memory = (await readMemory(config)) ?? emptyMemoryStore();
  const normalizedMatch = normalizeOverrideMatch(input.type, input.match);
  const collection = overridesForType(memory, input.type);
  const existing = collection.find(
    (rule) => rule.normalizedMatch === normalizedMatch && rule.categoryId === input.categoryId,
  );

  if (existing) {
    existing.note = input.note ?? existing.note;
    existing.match = input.match;
    await writeMemory(config, {
      ...memory,
      updatedAt: new Date().toISOString(),
    });
    return existing;
  }

  const created: ManualOverrideRule = {
    id: randomUUID(),
    type: input.type,
    match: input.match,
    normalizedMatch,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    note: input.note ?? null,
    createdAt: new Date().toISOString(),
  };

  collection.push(created);

  await writeMemory(config, {
    ...memory,
    updatedAt: new Date().toISOString(),
  });

  return created;
}
