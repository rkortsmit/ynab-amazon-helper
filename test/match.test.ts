import { describe, expect, test } from "bun:test";
import { matchTransactions } from "../src/match.ts";
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
