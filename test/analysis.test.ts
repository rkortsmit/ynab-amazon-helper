import { describe, expect, test } from "bun:test";
import { buildAnalysisBundle } from "../src/analysis.ts";
import type {
  MatchCandidate,
  MemoryStore,
  TransactionMatch,
  YnabAccount,
  YnabCategory,
  YnabTransaction,
} from "../src/types.ts";

const account: YnabAccount = {
  id: "acct-1",
  name: "Amazon Visa",
};

const categories: YnabCategory[] = [
  {
    id: "cat-grocery",
    name: "Groceries",
    groupId: "group-1",
    groupName: "Everyday",
    hidden: false,
    deleted: false,
  },
];

const baseTransaction: YnabTransaction = {
  id: "txn-1",
  date: "2026-04-09",
  amountMilliunits: -54190,
  amountCents: -5419,
  approved: false,
  cleared: "cleared",
  memo: null,
  payeeName: "Amazon",
  importPayeeName: "Amazon",
  importPayeeNameOriginal: "Amazon",
  accountId: "acct-1",
  accountName: "Amazon Visa",
  categoryId: null,
  categoryName: null,
  deleted: false,
};

const baseCandidate: MatchCandidate = {
  score: 126,
  confidence: "medium",
  amountSource: "order_total",
  dayDelta: 1,
  reasons: ["exact order total match", "date delta 1 day"],
  order: {
    profile: "wife",
    marketplace: "https://www.amazon.com",
    detailUrl: "https://www.amazon.com/your-orders/order-details?orderID=1",
    orderNumber: "111-2222222-3333333",
    orderDate: "2026-04-08",
    orderTotalCents: 5419,
    chargeAmountsCents: [],
    itemTitles: ["Carnation Breakfast Essentials High Protein with Fiber Ready-to-Drink"],
    paymentLast4: ["1862"],
    rawPreview: "preview",
    scrapedAt: "2026-04-11T00:00:00.000Z",
  },
};

function buildMatch(): TransactionMatch {
  return {
    transaction: baseTransaction,
    candidates: [baseCandidate],
    best: baseCandidate,
    ambiguous: false,
  };
}

function buildMemory(topCount: number, totalExamples: number): MemoryStore {
  return {
    version: 1,
    updatedAt: "2026-04-11T00:00:00.000Z",
    source: {
      sinceDate: "2025-04-11",
      historyTransactions: totalExamples,
      matchedTransactions: totalExamples,
      cachedOrders: 10,
    },
    overrides: {
      containsTitleRules: [],
      exactItemRules: [],
      exactFingerprintRules: [],
    },
    learned: {
      exactItemRules: [
        {
          key: "carnation breakfast essentials high protein with fiber ready to drink",
          topCategoryId: "cat-grocery",
          topCategoryName: "Groceries",
          topCount,
          totalExamples,
          uniqueCategories: 1,
          categories: [
            {
              categoryId: "cat-grocery",
              categoryName: "Groceries",
              count: topCount,
              lastSeen: "2026-04-01",
            },
          ],
        },
      ],
      exactFingerprintRules: [
        {
          key: "carnation breakfast essentials high protein with fiber ready to drink",
          topCategoryId: "cat-grocery",
          topCategoryName: "Groceries",
          topCount,
          totalExamples,
          uniqueCategories: 1,
          categories: [
            {
              categoryId: "cat-grocery",
              categoryName: "Groceries",
              count: topCount,
              lastSeen: "2026-04-01",
            },
          ],
        },
      ],
    },
    historyExamples: [],
  };
}

describe("buildAnalysisBundle", () => {
  test("keeps one-off learned examples in needs_review", () => {
    const bundle = buildAnalysisBundle({
      account,
      categories,
      memory: buildMemory(1, 1),
      matches: [buildMatch()],
      pendingSinceDate: "2026-01-01",
    });

    expect(bundle.summary.autoApply).toBe(0);
    expect(bundle.transactions[0]?.decision.status).toBe("needs_review");
  });

  test("auto applies repeated consistent history", () => {
    const bundle = buildAnalysisBundle({
      account,
      categories,
      memory: buildMemory(2, 2),
      matches: [buildMatch()],
      pendingSinceDate: "2026-01-01",
    });

    expect(bundle.summary.autoApply).toBe(1);
    expect(bundle.transactions[0]?.decision.status).toBe("auto_apply");
    expect(bundle.transactions[0]?.decision.proposedCategoryName).toBe("Groceries");
  });
});
