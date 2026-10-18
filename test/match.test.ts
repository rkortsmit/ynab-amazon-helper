import { describe, expect, test } from "bun:test";
import { isAmazonishTransaction, matchTransactions } from "../src/match.ts";
import type { AmazonOrder, AmazonPaymentTransaction, YnabTransaction } from "../src/types.ts";

const transaction: YnabTransaction = {
  id: "txn-1",
  date: "2026-04-09",
  amountMilliunits: -23790,
  amountCents: -2379,
  approved: false,
  cleared: "uncleared",
  memo: null,
  payeeName: "Amazon",
  importPayeeName: "AMAZON MKTPLACE PMTS",
  importPayeeNameOriginal: "AMAZON MKTPLACE PMTS",
  accountId: "acct-1",
  accountName: "Amazon Card",
  categoryId: null,
  categoryName: null,
  deleted: false,
};

function order(overrides: Partial<AmazonOrder>): AmazonOrder {
  return {
    profile: "you",
    marketplace: "https://www.amazon.com",
    detailUrl: "https://www.amazon.com/gp/your-account/order-details?orderID=1",
    orderNumber: "111-2222222-3333333",
    orderDate: "2026-04-08",
    orderTotalCents: 2379,
    chargeAmountsCents: [],
    itemTitles: ["USB-C Cable"],
    paymentLast4: ["1234"],
    rawPreview: "preview",
    scrapedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function payment(overrides: Partial<AmazonPaymentTransaction>): AmazonPaymentTransaction {
  return {
    profile: "you",
    marketplace: "https://www.amazon.com",
    transactionDate: "2026-04-09",
    transactionStatus: "completed",
    paymentInstrument: "Prime Visa ****1234",
    paymentLast4: "1234",
    amountCents: -2379,
    orderNumber: "111-2222222-3333333",
    merchant: "AMZN Mktp US",
    kind: "charge",
    rawPreview: "preview",
    scrapedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("matchTransactions", () => {
  test("prefers exact charge matches", () => {
    const exactCharge = order({
      detailUrl: "https://www.amazon.com/order/charge",
      chargeAmountsCents: [2379],
      orderTotalCents: 4899,
    });

    const totalOnly = order({
      detailUrl: "https://www.amazon.com/order/total",
      orderNumber: "222-3333333-4444444",
      chargeAmountsCents: [],
      orderTotalCents: 2379,
    });

    const [result] = matchTransactions([transaction], [totalOnly, exactCharge]);
    expect(result.best?.order.detailUrl).toBe("https://www.amazon.com/order/charge");
    expect(result.best?.amountSource).toBe("charge");
    expect(result.ambiguous).toBe(false);
  });

  test("marks close contenders as ambiguous", () => {
    const first = order({
      detailUrl: "https://www.amazon.com/order/one",
      orderNumber: "333-4444444-5555555",
      chargeAmountsCents: [2379],
      orderDate: "2026-04-09",
    });

    const second = order({
      detailUrl: "https://www.amazon.com/order/two",
      orderNumber: "444-5555555-6666666",
      chargeAmountsCents: [2379],
      orderDate: "2026-04-09",
    });

    const [result] = matchTransactions([transaction], [first, second]);
    expect(result.best).not.toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  test("prefers exact payments-page matches over order totals", () => {
    const totalOnly = order({
      detailUrl: "https://www.amazon.com/order/total",
      orderNumber: "222-3333333-4444444",
      chargeAmountsCents: [],
      orderTotalCents: 2379,
      orderDate: "2026-04-01",
    });

    const exactPayment = payment({
      orderNumber: "222-3333333-4444444",
      transactionDate: "2026-04-09",
      amountCents: -2379,
    });

    const [result] = matchTransactions([transaction], [totalOnly], [exactPayment]);
    expect(result.best?.amountSource).toBe("payment_transaction");
    expect(result.best?.order.orderNumber).toBe("222-3333333-4444444");
    expect(result.ambiguous).toBe(false);
  });

  test("matches refund inflows against payments-page refunds", () => {
    const refundTransaction: YnabTransaction = {
      ...transaction,
      id: "txn-refund",
      amountMilliunits: 26690,
      amountCents: 2669,
      payeeName: "Amazon",
      importPayeeName: "AMAZON MKTPLACE PMTS",
      importPayeeNameOriginal: "AMAZON MKTPLACE PMTS",
    };

    const refundPayment = payment({
      amountCents: 2669,
      kind: "refund",
      transactionDate: "2026-04-09",
      orderNumber: "555-6666666-7777777",
    });

    const [result] = matchTransactions([refundTransaction], [], [refundPayment]);
    expect(result.best?.amountSource).toBe("payment_transaction");
    expect(result.best?.order.orderNumber).toBe("555-6666666-7777777");
    expect(result.best?.reasons[0]).toContain("refund");
  });
});

describe("date limits", () => {
  test("ignores an old order and an old payments entry with the same amount", () => {
    const old = order({ orderNumber: "111-0000000-0000001", orderDate: "2025-11-02", chargeAmountsCents: [2379] });
    const oldPay = payment({ orderNumber: "111-0000000-0000001", transactionDate: "2025-11-03" });
    const [m] = matchTransactions([transaction], [old], [oldPay]);
    expect(m.best).toBeNull();
  });
  test("a charge 20 days after the order is only a weak match", () => {
    const late = order({ orderDate: "2026-03-20", chargeAmountsCents: [2379] });
    const [m] = matchTransactions([transaction], [late], []);
    expect(m.best?.confidence).toBe("weak");
  });
  test("prefers the recent order over an old one with the same amount", () => {
    const old = order({ orderNumber: "111-0000000-0000001", orderDate: "2026-01-05" });
    const recent = order({ orderNumber: "111-0000000-0000002", orderDate: "2026-04-08" });
    const [m] = matchTransactions([transaction], [old, recent], []);
    expect(m.best?.order.orderNumber).toBe("111-0000000-0000002");
    expect(m.ambiguous).toBe(false);
  });
});

describe("ambiguity", () => {
  test("two payments-page entries for the same order are not ambiguous", () => {
    const first = payment({ transactionDate: "2026-04-09" });
    const second = payment({ transactionDate: "2026-04-08" });
    const [m] = matchTransactions([transaction], [], [first, second]);
    expect(m.candidates.length).toBe(2);
    expect(m.ambiguous).toBe(false);
  });
  test("payments without order numbers are still treated as different purchases", () => {
    const first = payment({ orderNumber: null, transactionDate: "2026-04-09" });
    const second = payment({ orderNumber: null, transactionDate: "2026-04-08" });
    const [m] = matchTransactions([transaction], [], [first, second]);
    expect(m.ambiguous).toBe(true);
  });
  test("two different orders with the same amount are still ambiguous", () => {
    const first = payment({ orderNumber: "111-0000000-0000001" });
    const second = payment({ orderNumber: "111-0000000-0000002" });
    const [m] = matchTransactions([transaction], [], [first, second]);
    expect(m.ambiguous).toBe(true);
  });
});

describe("isAmazonishTransaction", () => {
  test("recognises bank-style AMZN payees", () => {
    const amzn: YnabTransaction = {
      ...transaction,
      payeeName: "AMZN Mktp US*1A2B3",
      importPayeeName: "AMZN Mktp US*1A2B3",
      importPayeeNameOriginal: "AMZN Mktp US*1A2B3",
    };
    expect(isAmazonishTransaction(amzn)).toBe(true);
  });
  test("ignores unrelated payees and transfers", () => {
    const other: YnabTransaction = {
      ...transaction,
      payeeName: "Kroger",
      importPayeeName: "KROGER #123",
      importPayeeNameOriginal: "KROGER #123",
    };
    expect(isAmazonishTransaction(other)).toBe(false);
    expect(isAmazonishTransaction({ ...transaction, transferAccountId: "acct-2" })).toBe(false);
  });
});
