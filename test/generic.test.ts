import { describe, expect, test } from "bun:test";
import { buildGenericAnalysisTransactions, buildGenericHistory } from "../src/generic.ts";
import type { YnabCategory, YnabTransaction } from "../src/types.ts";

const categories: YnabCategory[] = [
  {
    id: "cat-restaurants",
    name: "Restaurants",
    groupId: "group-1",
    groupName: "Food",
    hidden: false,
    deleted: false,
  },
  {
    id: "cat-activities",
    name: "Activities",
    groupId: "group-2",
    groupName: "Kids",
    hidden: false,
    deleted: false,
  },
  {
    id: "cat-clothing",
    name: "👠Clothing",
    groupId: "group-3",
    groupName: "Personal",
    hidden: false,
    deleted: false,
  },
];

function transaction(overrides: Partial<YnabTransaction>): YnabTransaction {
  return {
    id: "txn-1",
    date: "2026-04-12",
    amountMilliunits: -15320,
    amountCents: -1532,
    approved: true,
    cleared: "cleared",
    memo: null,
    payeeName: "Chick-fil-A",
    importPayeeName: "CHICK-FIL-A",
    importPayeeNameOriginal: "CHICK-FIL-A",
    accountId: "acct-checking",
    accountName: "Checking",
    categoryId: "cat-restaurants",
    categoryName: "Restaurants",
    deleted: false,
    ...overrides,
  };
}

describe("generic reconciliation", () => {
  test("auto applies repeated consistent payee history", () => {
    const history = buildGenericHistory(
      [
        transaction({ id: "hist-1", date: "2026-03-01" }),
        transaction({ id: "hist-2", date: "2026-03-05", amountMilliunits: -18990, amountCents: -1899 }),
        transaction({ id: "hist-3", date: "2026-03-20", amountMilliunits: -22100, amountCents: -2210 }),
      ],
      "2025-04-12",
    );

    const [result] = buildGenericAnalysisTransactions({
      transactions: [transaction({ id: "pending-1", approved: false, categoryId: null, categoryName: null })],
      categories,
      history,
    });

    expect(result?.workflow).toBe("generic");
    expect(result?.decision.status).toBe("auto_apply");
    expect(result?.decision.proposedCategoryName).toBe("Restaurants");
  });

  test("uses repeated payee plus memo history for memo-specific payees", () => {
    const history = buildGenericHistory(
      [
        transaction({
          id: "hist-venmo-1",
          payeeName: "Venmo",
          importPayeeName: "VENMO",
          importPayeeNameOriginal: "VENMO",
          memo: "Piano lesson",
          categoryId: "cat-activities",
          categoryName: "Activities",
        }),
        transaction({
          id: "hist-venmo-2",
          date: "2026-03-18",
          payeeName: "Venmo",
          importPayeeName: "VENMO",
          importPayeeNameOriginal: "VENMO",
          memo: "Piano lesson",
          categoryId: "cat-activities",
          categoryName: "Activities",
        }),
      ],
      "2025-04-12",
    );

    const [result] = buildGenericAnalysisTransactions({
      transactions: [
        transaction({
          id: "pending-venmo",
          approved: false,
          categoryId: null,
          categoryName: null,
          payeeName: "Venmo",
          importPayeeName: "VENMO",
          importPayeeNameOriginal: "VENMO",
          memo: "Piano lesson",
        }),
      ],
      categories,
      history,
    });

    expect(result?.decision.status).toBe("auto_apply");
    expect(result?.decision.proposedCategoryName).toBe("Activities");
  });

  test("auto applies refund inflows when a prior categorized outflow exists", () => {
    const history = buildGenericHistory(
      [
        transaction({
          id: "hist-oldnavy",
          payeeName: "Old Navy",
          importPayeeName: "OLD NAVY",
          importPayeeNameOriginal: "OLD NAVY",
          amountMilliunits: -26690,
          amountCents: -2669,
          categoryId: "cat-clothing",
          categoryName: "👠Clothing",
        }),
      ],
      "2025-04-12",
    );

    const [result] = buildGenericAnalysisTransactions({
      transactions: [
        transaction({
          id: "refund-oldnavy",
          approved: false,
          categoryId: null,
          categoryName: null,
          payeeName: "Old Navy",
          importPayeeName: "OLD NAVY",
          importPayeeNameOriginal: "OLD NAVY",
          amountMilliunits: 26690,
          amountCents: 2669,
        }),
      ],
      categories,
      history,
    });

    expect(result?.decision.status).toBe("auto_apply");
    expect(result?.decision.proposedCategoryName).toBe("👠Clothing");
    expect(result?.suggestions[0]?.evidences[0]?.type).toBe("history_refund_match");
  });

  test("keeps transfer-like transactions in manual review", () => {
    const history = buildGenericHistory([], "2025-04-12");

    const [result] = buildGenericAnalysisTransactions({
      transactions: [
        transaction({
          id: "payment-thank-you",
          approved: false,
          categoryId: null,
          categoryName: null,
          payeeName: "Payment Thank You",
          importPayeeName: "PAYMENT THANK YOU",
          importPayeeNameOriginal: "PAYMENT THANK YOU",
        }),
      ],
      categories,
      history,
    });

    expect(result?.decision.status).toBe("needs_review");
    expect(result?.decision.proposedCategoryName).toBeNull();
    expect(result?.suggestions).toHaveLength(0);
  });
});
