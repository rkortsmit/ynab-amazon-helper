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
