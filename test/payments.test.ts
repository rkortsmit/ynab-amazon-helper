import { describe, expect, test } from "bun:test";
import { parsePaymentsTransactionsText } from "../src/amazon.ts";

const samplePage = `
Transactions
In Progress
April 11, 2026
Prime Visa ****1862
-$39.73
Pending
Order #113-1231745-1174648
Amazon.com
Completed
April 8, 2026
Prime Visa ****1862
-$43.53
Order #113-8174319-1990658
AMZN Mktp US
Amazon Gift Card
-$15.90
Order #112-3380456-4367413
AMAZON MKTPLACE PMTS
April 1, 2026
Prime Visa ****1862
+$26.69
Refund: Order #113-5815656-8760227
AMZN Mktp US
Previous Page
Next Page
`;

describe("parsePaymentsTransactionsText", () => {
  test("extracts payment rows with dates, amounts, order numbers, and refunds", () => {
    const transactions = parsePaymentsTransactionsText({
      profile: "primary",
      marketplace: "https://www.amazon.com",
      text: samplePage,
      scrapedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(transactions).toHaveLength(4);
    expect(transactions[0]).toMatchObject({
      transactionDate: "2026-04-11",
      transactionStatus: "pending",
      paymentInstrument: "Prime Visa ****1862",
      paymentLast4: "1862",
      amountCents: -3973,
      orderNumber: "113-1231745-1174648",
      merchant: "Amazon.com",
      kind: "charge",
    });

    expect(transactions[1]).toMatchObject({
      transactionDate: "2026-04-08",
      transactionStatus: "completed",
      paymentInstrument: "Prime Visa ****1862",
      amountCents: -4353,
      orderNumber: "113-8174319-1990658",
      merchant: "AMZN Mktp US",
      kind: "charge",
    });

    expect(transactions[2]).toMatchObject({
      transactionDate: "2026-04-08",
      transactionStatus: "completed",
      paymentInstrument: "Amazon Gift Card",
      amountCents: -1590,
      orderNumber: "112-3380456-4367413",
      merchant: "AMAZON MKTPLACE PMTS",
      kind: "charge",
    });

    expect(transactions[3]).toMatchObject({
      transactionDate: "2026-04-01",
      transactionStatus: "completed",
      amountCents: 2669,
      orderNumber: "113-5815656-8760227",
      merchant: "AMZN Mktp US",
      kind: "refund",
    });
  });
});

// Layout used by newer Your Payments pages: one block per charge, date and merchant on one line.
const newLayoutPage = `
Skip to
Main content
View gift card activity to see gift card refunds.
Oct 19, 2026\u00b7AMZN Mktp US
Prime Visa\u2022\u2022\u2022\u20229999
Order #111-0000001-0000001
-$36.35
Charged
Oct 09, 2026\u00b7Amazon.com
Amazon Chase Co-Branded Credit Card Rewards
Order #111-0000002-0000002
-$3.32
Charged
Oct 03, 2026\u00b7AMZN Mktp US
Prime Visa\u2022\u2022\u2022\u20229999
Order #111-0000003-0000003
+$28.88
Refunded
Sep 26, 2026\u00b7AMZN Mktp US
Prime Visa\u2022\u2022\u2022\u20229999
Order #111-0000004-0000004
-$9.62
Pending
Back to top
Get to Know Us
Oct 01, 2026\u00b7AMZN Mktp US
Prime Visa\u2022\u2022\u2022\u20229999
Order #111-0000005-0000005
-$1.00
Charged
`;

describe("parsePaymentsTransactionsText (newer layout)", () => {
  const transactions = parsePaymentsTransactionsText({
    profile: "primary",
    marketplace: "https://www.amazon.com",
    text: newLayoutPage,
    scrapedAt: "2026-10-19T00:00:00.000Z",
  });

  test("reads one charge per block and stops at the page footer", () => {
    expect(transactions).toHaveLength(4);
  });

  test("reads the date, merchant, card, order number and amount", () => {
    expect(transactions[0]).toMatchObject({
      transactionDate: "2026-10-19",
      transactionStatus: "completed",
      paymentLast4: "9999",
      amountCents: -3635,
      orderNumber: "111-0000001-0000001",
      merchant: "AMZN Mktp US",
      kind: "charge",
    });
  });

  test("handles zero-padded days and rewards-card rows without a card number", () => {
    expect(transactions[1]).toMatchObject({
      transactionDate: "2026-10-09",
      paymentInstrument: "Amazon Chase Co-Branded Credit Card Rewards",
      paymentLast4: null,
      amountCents: -332,
      merchant: "Amazon.com",
    });
  });

  test("treats a refunded row as a refund and a pending row as pending", () => {
    expect(transactions[2]).toMatchObject({ amountCents: 2888, kind: "refund", transactionStatus: "completed" });
    expect(transactions[3]).toMatchObject({ amountCents: -962, kind: "charge", transactionStatus: "pending" });
  });
});
