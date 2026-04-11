import { describe, expect, test } from "bun:test";
import { generateMemoFromMatch } from "../src/memo.ts";
import type { MatchCandidate } from "../src/types.ts";

function candidate(itemTitles: string[]): MatchCandidate {
  return {
    score: 150,
    confidence: "strong",
    amountSource: "payment_transaction",
    dayDelta: 0,
    reasons: ["exact payments-page transaction match"],
    order: {
      profile: "you",
      marketplace: "https://www.amazon.com",
      detailUrl: "https://www.amazon.com/your-orders/order-details?orderID=1",
      orderNumber: "111-2222222-3333333",
      orderDate: "2026-04-11",
      orderTotalCents: 1234,
      chargeAmountsCents: [1234],
      itemTitles,
      paymentLast4: ["1862"],
      rawPreview: "preview",
      scrapedAt: "2026-04-11T00:00:00.000Z",
    },
  };
}

describe("generateMemoFromMatch", () => {
  test("compacts single-item titles into a short memo", () => {
    const memo = generateMemoFromMatch(
      candidate(["Carnation Breakfast Essentials High Protein with Fiber Ready-to-Drink, 8 FL OZ Carton"]),
    );

    expect(memo).toBe("Carnation Breakfast Essentials High Protein with Fiber Ready-to-Drink");
  });

  test("summarizes multi-item orders without overflowing", () => {
    const memo = generateMemoFromMatch(
      candidate([
        "Wooqu Book Cloth, Fabric Surface and Paper Backed, Easy to Use, Strong, 17x29”, for Book Binding, Dark Red",
        "HeatnBond UltraHold Iron-On Adhesive Value Pack, 17 Inches x 5 Yards, White",
        "Kozo Studio - Premium Unryu Rice Paper for Decoupage (40 Sheets)",
      ]),
    );

    expect(memo).toBe("Wooqu Book Cloth + 2 more");
  });

  test("prefixes refund memos", () => {
    const memo = generateMemoFromMatch(candidate(["Debrox Kids Drying Drops"]), {
      refund: true,
    });

    expect(memo).toBe("Refund: Debrox Kids Drying Drops");
  });
});
