import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import type { AppConfig } from "./config.ts";
import type { AmazonOrder, AmazonOrderCostSummary, AmazonOrderItem, AmazonPaymentTransaction } from "./types.ts";
import { ensureDir, parseMoneyToCents, parseUsDateToIso } from "./utils.ts";

type SyncOptions = {
  profile: string;
  pages: number;
  marketplace: string;
};

function normalizeOrderDetailUrl(detailUrl: string): string {
  try {
    const url = new URL(detailUrl);
    const orderId = url.searchParams.get("orderID") ?? url.searchParams.get("orderId");
    const normalized = new URL(url.origin + url.pathname);
    if (orderId) {
      normalized.searchParams.set("orderID", orderId);
    }
    return normalized.toString();
  } catch {
    return detailUrl;
  }
}

async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input, output });
  await rl.question(`${message}\n`);
  rl.close();
}

function orderHistoryUrl(marketplace: string): string {
  return new URL("/gp/css/order-history", marketplace).toString();
}

function paymentsTransactionsUrl(marketplace: string): string {
  return new URL("/cpe/yourpayments/transactions", marketplace).toString();
}

async function pageText(page: Page): Promise<string> {
  return page.locator("body").innerText().catch(() => "");
}

async function waitForManualFix(page: Page, message: string, targetUrl: string): Promise<void> {
  console.log(message);
  await waitForEnter("Press Enter here once the browser is ready to continue.");
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_500);
}

async function ensureOrderHistoryPage(page: Page, marketplace: string): Promise<void> {
  const targetUrl = orderHistoryUrl(marketplace);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentText = await pageText(page);
    const currentUrl = page.url();
    const hasLinks = (await page.locator('a[href*="/gp/your-account/order-details"]').count()) > 0;

    if (hasLinks || /your orders/i.test(currentText)) {
      return;
    }

    if (/sign in/i.test(currentText) || currentUrl.includes("/ap/signin")) {
      await waitForManualFix(
        page,
        "Amazon needs you to sign in in the opened browser window. MFA and captchas stay fully manual.",
        targetUrl,
      );
      continue;
    }

    if (/characters you see below|enter the characters you see/i.test(currentText) || currentUrl.includes("validateCaptcha")) {
      await waitForManualFix(
        page,
        "Amazon is showing a captcha. Solve it in the browser, then come back here.",
        targetUrl,
      );
      continue;
    }

    await waitForManualFix(
      page,
      "The order-history page was not detected automatically. In the browser, navigate to Your Orders, then come back here.",
      targetUrl,
    );
  }

  throw new Error("Unable to confirm the Amazon order-history page after several attempts.");
}

async function ensurePaymentsTransactionsPage(page: Page, marketplace: string): Promise<void> {
  const targetUrl = paymentsTransactionsUrl(marketplace);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentText = await pageText(page);
    const currentUrl = page.url();

    if (/your account .* your payments .* transactions/i.test(currentText.replace(/\n+/g, " ")) || /transactions/i.test(currentText)) {
      return;
    }

    if (/sign in/i.test(currentText) || currentUrl.includes("/ap/signin")) {
      await waitForManualFix(
        page,
        "Amazon needs you to sign in before the payments transaction page can be read. MFA and captchas stay fully manual.",
        targetUrl,
      );
      continue;
    }

    if (/characters you see below|enter the characters you see/i.test(currentText) || currentUrl.includes("validateCaptcha")) {
      await waitForManualFix(
        page,
        "Amazon is showing a captcha on the payments transaction page. Solve it in the browser, then come back here.",
        targetUrl,
      );
      continue;
    }

    await waitForManualFix(
      page,
      "The payments transaction page was not detected automatically. In the browser, navigate to Your Payments > Transactions, then come back here.",
      targetUrl,
    );
  }

  throw new Error("Unable to confirm the Amazon payments transaction page after several attempts.");
}

async function collectOrderDetailLinks(page: Page, pages: number): Promise<string[]> {
  const found = new Set<string>();

  for (let index = 0; index < pages; index += 1) {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1_500);

    const urls = await page
      .locator('a[href*="/order-details"]')
      .evaluateAll((elements) =>
        [...new Set(elements.map((element) => (element as HTMLAnchorElement).href.split("#")[0]))].filter(Boolean),
      )
      .catch(() => []);

    for (const url of urls) {
      found.add(normalizeOrderDetailUrl(url));
    }

    const nextHref = await page.evaluate(() => {
      const selectors = [
        'li.a-last a',
        'a[aria-label="Go to next page"]',
        'a.a-last',
        'a[href*="startIndex="][href*="pagination"]',
      ];

      for (const selector of selectors) {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
        for (const anchor of anchors) {
          const text = anchor.textContent?.trim() ?? "";
          if (anchor.href && /next|→/i.test(text || anchor.href)) {
            return anchor.href;
          }
        }
      }

      const explicitNext = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) =>
        /next|→/i.test(anchor.textContent?.trim() ?? ""),
      );

      if (explicitNext?.href) {
        return explicitNext.href;
      }

      return null;
    });

    if (!nextHref || index === pages - 1) {
      break;
    }

    await page.goto(nextHref, { waitUntil: "domcontentloaded" });
  }

  return [...found];
}

async function goToNextPaymentsPage(page: Page): Promise<boolean> {
  const nextButton = page.locator('input[type="submit"][name*="NextPageNavigationEvent"]').first();

  if ((await nextButton.count()) === 0) {
    return false;
  }

  const before = await pageText(page);
  await nextButton.click();

  try {
    await page.waitForFunction(
      (previous) => (document.body?.innerText ?? "").trim() !== previous.trim(),
      before,
      { timeout: 15_000 },
    );
  } catch {
    // Some transitions reuse the same text structure. Continue and let the caller
    // decide whether a new page was actually available based on parsed rows.
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1_500);
  return true;
}

export function parsePaymentsTransactionsText(input: {
  profile: string;
  marketplace: string;
  text: string;
  scrapedAt?: string;
}): AmazonPaymentTransaction[] {
  const lines = input.text
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const transactions: AmazonPaymentTransaction[] = [];
  let currentSection: AmazonPaymentTransaction["transactionStatus"] = "unknown";
  let currentDate: string | null = null;
  const seen = new Set<string>();

  function isDateHeading(value: string): boolean {
    return /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(value);
  }

  function isAmountLine(value: string): boolean {
    return /^[+-]?\$[\d,]+\.\d{2}$/.test(value);
  }

  function isPaymentInstrument(value: string): boolean {
    return !isDateHeading(value) && !isAmountLine(value) && value.length <= 80;
  }

  function extractOrderNumber(value: string): string | null {
    const match =
      value.match(/(?:Refund:\s*)?Order #([A-Z0-9-]{10,})/i) ??
      value.match(/^([A-Z0-9]{3}-\d{7}-\d{7})$/);
    return match?.[1] ?? null;
  }

  function shouldStop(value: string): boolean {
    return (
      /^previous page$/i.test(value) ||
      /^back to top$/i.test(value) ||
      /^get to know us$/i.test(value) ||
      /^amazon music$/i.test(value)
    );
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (shouldStop(line)) {
      break;
    }

    if (/^completed$/i.test(line)) {
      currentSection = "completed";
      continue;
    }

    if (/^in progress$/i.test(line)) {
      currentSection = "in_progress";
      continue;
    }

    if (isDateHeading(line)) {
      currentDate = parseUsDateToIso(line);
      continue;
    }

    if (!currentDate || !isPaymentInstrument(line) || !isAmountLine(lines[index + 1] ?? "")) {
      continue;
    }

    const amountCents = parseMoneyToCents(lines[index + 1]);
    if (amountCents === null) {
      continue;
    }

    let cursor = index + 2;
    let transactionStatus: AmazonPaymentTransaction["transactionStatus"] = currentSection;

    if (/^pending$/i.test(lines[cursor] ?? "")) {
      transactionStatus = "pending";
      cursor += 1;
    }

    let orderNumber: string | null = null;
    while (cursor < lines.length) {
      const candidate = extractOrderNumber(lines[cursor] ?? "");
      if (!candidate) {
        break;
      }

      orderNumber = candidate;
      cursor += 1;
    }

    let merchant: string | null = lines[cursor] ?? null;
    if (
      !merchant ||
      isDateHeading(merchant) ||
      /^completed$/i.test(merchant) ||
      /^in progress$/i.test(merchant) ||
      shouldStop(merchant) ||
      isAmountLine(merchant)
    ) {
      merchant = null;
      cursor -= 1;
    }

    const paymentLast4 = line.match(/(\d{4})(?!.*\d)/)?.[1] ?? null;
    const kind: AmazonPaymentTransaction["kind"] =
      amountCents > 0 || /^refund:/i.test(lines[index + 2] ?? "") ? "refund" : amountCents < 0 ? "charge" : "other";
    const rawPreview = lines.slice(index, Math.min(lines.length, cursor + 2)).join(" | ").slice(0, 400);
    const key = [currentDate, amountCents, orderNumber ?? "", line, merchant ?? "", transactionStatus].join("::");

    if (!seen.has(key)) {
      seen.add(key);
      transactions.push({
        profile: input.profile,
        marketplace: input.marketplace,
        transactionDate: currentDate,
        transactionStatus,
        paymentInstrument: line,
        paymentLast4,
        amountCents,
        orderNumber,
        merchant,
        kind,
        rawPreview,
        scrapedAt: input.scrapedAt ?? new Date().toISOString(),
      });
    }

    index = Math.max(index, cursor);
  }

  return transactions;
}

async function scrapeOrder(page: Page, detailUrl: string, profile: string, marketplace: string): Promise<AmazonOrder> {
  const normalizedDetailUrl = normalizeOrderDetailUrl(detailUrl);
  await page.goto(normalizedDetailUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1_200);

  const order = await page.evaluate(({ detailUrl, profile, marketplace }) => {
    const text = document.body.innerText.replace(/\u00a0/g, " ");
    const lines = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    const ignoreTitles = new Set([
      "Track package",
      "Buy it again",
      "Write a product review",
      "Leave seller feedback",
      "View or edit order",
      "Get product support",
      "Archive order",
      "Invoice",
      "Return or replace items",
    ]);

    function firstMatch(patterns: RegExp[]): string | null {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
          return match[1].trim();
        }
      }
      return null;
    }

    function parseMoney(value: string | null): number | null {
      if (!value) {
        return null;
      }

      const match = value.replace(/,/g, "").match(/(-?)\$?\s*(\d+)(?:\.(\d{2}))?/);
      if (!match) {
        return null;
      }

      const sign = match[1] === "-" ? -1 : 1;
      return sign * (Number(match[2]) * 100 + Number(match[3] ?? "0"));
    }

    function dateToIso(value: string | null): string | null {
      if (!value) {
        return null;
      }

      const parsed = new Date(`${value} 12:00:00 UTC`);
      if (Number.isNaN(parsed.getTime())) {
        return null;
      }

      return parsed.toISOString().slice(0, 10);
    }

    function extractOrderDate(): string | null {
      const inline = text.match(/Order placed\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
      if (inline?.[1]) {
        return dateToIso(inline[1]);
      }

      const labeled = extractLabeledValue(["Order placed", "Order date", "Ordered on"]);
      if (!labeled) {
        return null;
      }

      const cleaned = labeled.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/);
      return dateToIso(cleaned?.[1] ?? labeled);
    }

    function extractItemTitles(): string[] {
      const items: string[] = [];
      const seen = new Set<string>();

      for (let index = 0; index < lines.length - 1; index += 1) {
        const line = lines[index];
        const next = lines[index + 1] ?? "";

        if (!line || line.length < 4 || line.length > 220) {
          continue;
        }

        if (ignoreTitles.has(line)) {
          continue;
        }

        if (
          /^Sold by:/i.test(line) ||
          /^Return or replace items/i.test(line) ||
          /^Return items/i.test(line) ||
          /^Track package$/i.test(line) ||
          /^Buy it again$/i.test(line) ||
          /^View your item$/i.test(line) ||
          /^Get product support$/i.test(line) ||
          /^Share gift receipt$/i.test(line) ||
          /^Write a product review$/i.test(line) ||
          /^Ask Product Question$/i.test(line) ||
          /^Leave seller feedback$/i.test(line) ||
          /^Customers Who Bought/i.test(line) ||
          /^Order Details$/i.test(line) ||
          /^Ship to$/i.test(line) ||
          /^Payment method$/i.test(line) ||
          /^Order Summary$/i.test(line) ||
          /^Order placed /i.test(line) ||
          /^Grand Total:/i.test(line) ||
          /^\$[\d,]+\.\d{2}$/.test(line) ||
          /^\d+(\.\d+)? out of 5 stars/.test(line) ||
          /^\d+$/.test(line)
        ) {
          continue;
        }

        if (/^Sold by:/i.test(next) || /^Condition:/i.test(next)) {
          if (!seen.has(line)) {
            seen.add(line);
            items.push(line);
          }
        }
      }

      return items.slice(0, 8);
    }

    function extractLabeledValue(labels: string[]): string | null {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const label of labels) {
          const inline = line.match(new RegExp(`^${label}:?\\s+(.+)$`, "i"));
          if (inline?.[1]) {
            return inline[1].trim();
          }

          if (new RegExp(`^${label}:?$`, "i").test(line)) {
            return lines[index + 1] ?? null;
          }
        }
      }

      return null;
    }

    function moneyForLabels(labels: string[]): number | null {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const label of labels) {
          const inline = line.match(new RegExp(`^${label}:?\\s+(.+)$`, "i"));
          if (inline?.[1]) {
            return parseMoney(inline[1]);
          }

          if (new RegExp(`^${label}:?$`, "i").test(line)) {
            return parseMoney(lines[index + 1] ?? null);
          }
        }
      }

      return null;
    }

    const chargeAmounts = new Set<number>();
    for (let index = 0; index < lines.length; index += 1) {
      const window = lines.slice(index, index + 3).join(" ");
      if (/ending in|payment method|charged to|visa|mastercard|discover|american express/i.test(window)) {
        for (const amount of window.match(/\$[\d,]+\.\d{2}/g) ?? []) {
          const cents = parseMoney(amount);
          if (cents !== null) {
            chargeAmounts.add(cents);
          }
        }
      }
    }

    const paymentLast4 = Array.from(
      new Set(
        (text.match(/ending in\s+(\d{4})/gi) ?? [])
          .map((value) => value.match(/(\d{4})/)?.[1] ?? null)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    return {
      profile,
      marketplace,
      detailUrl,
      orderNumber: firstMatch([/Order\s+#?\s*([0-9-]{10,})/i, /Order number\s*[:#]?\s*([0-9-]{10,})/i]),
      orderDate: extractOrderDate(),
      orderTotalCents: moneyForLabels(["Order total", "Grand total"]),
      chargeAmountsCents: [...chargeAmounts],
      itemTitles: extractItemTitles(),
      paymentLast4,
      rawPreview: lines.slice(0, 40).join(" | ").slice(0, 1_200),
      scrapedAt: new Date().toISOString(),
    };
  }, { detailUrl, profile, marketplace });

  // Item prices are optional extras: a layout change must never break the sync.
  try {
    const extracted = await extractOrderItems(page);
    if (extracted.items.length) {
      (order as AmazonOrder).items = extracted.items;
      (order as AmazonOrder).costSummary = extracted.summary;
    }
  } catch {
    // ignore
  }

  return order;
}

export async function syncAmazonOrders(config: AppConfig, options: SyncOptions): Promise<AmazonOrder[]> {
  const userDataDir = join(config.profilesDir, options.profile);
  await ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 980 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(orderHistoryUrl(options.marketplace), { waitUntil: "domcontentloaded" });
    await ensureOrderHistoryPage(page, options.marketplace);
    const detailUrls = await collectOrderDetailLinks(page, options.pages);

    console.log(`Found ${detailUrls.length} order detail pages for profile "${options.profile}".`);

    const orders: AmazonOrder[] = [];
    for (const [index, detailUrl] of detailUrls.entries()) {
      console.log(`Scraping ${index + 1}/${detailUrls.length}`);
      orders.push(await scrapeOrder(page, detailUrl, options.profile, options.marketplace));
    }

    return orders;
  } finally {
    await context.close();
  }
}

export async function syncAmazonPaymentTransactions(
  config: AppConfig,
  options: SyncOptions,
): Promise<AmazonPaymentTransaction[]> {
  const userDataDir = join(config.profilesDir, options.profile);
  await ensureDir(userDataDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 980 },
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(paymentsTransactionsUrl(options.marketplace), { waitUntil: "domcontentloaded" });
    await ensurePaymentsTransactionsPage(page, options.marketplace);

    const transactions: AmazonPaymentTransaction[] = [];

    for (let index = 0; index < options.pages; index += 1) {
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(1_500);
      const text = await pageText(page);
      const scrapedAt = new Date().toISOString();
      transactions.push(
        ...parsePaymentsTransactionsText({
          profile: options.profile,
          marketplace: options.marketplace,
          text,
          scrapedAt,
        }),
      );

      const hasNextPage = await goToNextPaymentsPage(page);
      if (!hasNextPage || index === options.pages - 1) {
        break;
      }
    }

    return transactions;
  } finally {
    await context.close();
  }
}

// ---------- item prices (best effort; Amazon's page layout varies) ----------

export type ExtractedOrderItems = {
  items: AmazonOrderItem[];
  summary: AmazonOrderCostSummary;
};

export async function extractOrderItems(page: Page): Promise<ExtractedOrderItems> {
  return page.evaluate(() => {
    const money = (value: string | null | undefined): number | null => {
      if (!value) return null;
      const m = value.replace(/,/g, "").match(/(-?)\$\s*(\d+)(?:\.(\d{2}))?/);
      if (!m) return null;
      return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3] ?? "0"));
    };
    const clean = (v: string | null | undefined) => (v ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
    const text = document.body.innerText.replace(/ /g, " ");
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

    const labeled = (labels: string[]): number | null => {
      for (let i = 0; i < lines.length; i += 1) {
        for (const label of labels) {
          const inline = lines[i].match(new RegExp(`^${label}:?\\s+(-?\\$[\\d,]+\\.\\d{2})`, "i"));
          if (inline) return money(inline[1]);
          if (new RegExp(`^${label}:?$`, "i").test(lines[i])) return money(lines[i + 1]);
        }
      }
      return null;
    };
    const summaryBase = {
      subtotalCents: labeled(["Item\\(s\\) Subtotal", "Items? Subtotal", "Subtotal"]),
      shippingCents: labeled(["Shipping & Handling", "Shipping"]),
      taxCents: labeled(["Estimated tax to be collected", "Estimated tax", "Tax"]),
      totalCents: labeled(["Grand Total", "Order Total", "Total"]),
    };

    // Strategy 1: newer layout with data-component markers.
    const blocks = Array.from(document.querySelectorAll('[data-component="purchasedItems"]'));
    const fromComponents: AmazonOrderItem[] = [];
    for (const block of blocks) {
      const title = clean((block.querySelector('[data-component="itemTitle"]') as HTMLElement | null)?.innerText);
      if (!title) continue;
      const priceEl = block.querySelector('[data-component="unitPrice"]') as HTMLElement | null;
      const qtyMatch = clean((block as HTMLElement).innerText).match(/\b(?:Qty|Quantity):?\s*(\d{1,3})\b/i);
      const badge = clean((block.querySelector(".od-item-view-qty, .item-view-qty") as HTMLElement | null)?.innerText);
      fromComponents.push({
        title,
        unitPriceCents: money(priceEl?.innerText),
        quantity: qtyMatch ? Number(qtyMatch[1]) : /^\d{1,3}$/.test(badge) ? Number(badge) : 1,
      });
    }
    if (fromComponents.length && fromComponents.some((i) => i.unitPriceCents !== null)) {
      return { items: fromComponents, summary: { ...summaryBase, strategy: "data-component" } };
    }

    // Strategy 2: page text. Item titles are the lines followed by "Sold by:" (same rule the sync uses);
    // the price is the first "$x.xx" line after the title and before the next item.
    const titleIdx: number[] = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (lines[i].length >= 4 && lines[i].length <= 220 && /^(Sold by:|Condition:)/i.test(lines[i + 1]) && !/^\$/.test(lines[i])) {
        titleIdx.push(i);
      }
    }
    const fromText: AmazonOrderItem[] = [];
    titleIdx.forEach((start, n) => {
      const end = Math.min(titleIdx[n + 1] ?? lines.length, start + 12);
      let price: number | null = null;
      let qty = 1;
      for (let j = start + 1; j < end; j += 1) {
        const q = lines[j].match(/^(?:Qty|Quantity):?\s*(\d{1,3})$/i);
        if (q) qty = Number(q[1]);
        if (price === null && /^\$[\d,]+\.\d{2}$/.test(lines[j])) price = money(lines[j]);
      }
      const before = lines[start - 1] ?? "";
      if (qty === 1 && /^\d{1,2}$/.test(before) && Number(before) >= 2 && Number(before) <= 50) qty = Number(before);
      fromText.push({ title: lines[start], unitPriceCents: price, quantity: qty });
    });
    return { items: fromText, summary: { ...summaryBase, strategy: fromText.some((i) => i.unitPriceCents !== null) ? "text" : "none" } };
  });
}

function orderDetailsUrl(marketplace: string, orderNumber: string): string {
  const url = new URL("/your-orders/order-details", marketplace);
  url.searchParams.set("orderID", orderNumber);
  return url.toString();
}

// Opens one order in the given profile's saved Amazon login, reads item prices, and (optionally) leaves the window open.
export async function openOrderInProfile(
  config: AppConfig,
  options: { profile: string; marketplace: string; orderNumber: string; keepOpen: boolean },
): Promise<ExtractedOrderItems> {
  const userDataDir = join(config.profilesDir, options.profile);
  await ensureDir(userDataDir);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1440, height: 980 },
  });

  let closed = false;
  context.on("close", () => {
    closed = true;
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const target = orderDetailsUrl(options.marketplace, options.orderNumber);
    await page.goto(target, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await pageText(page);
      if (current.includes(options.orderNumber) && !page.url().includes("/ap/signin")) break;
      if (/sign in/i.test(current) || page.url().includes("/ap/signin")) {
        await waitForManualFix(page, "Amazon needs you to sign in to this account in the opened browser window.", target);
        continue;
      }
      if (/characters you see below|enter the characters you see/i.test(current) || page.url().includes("validateCaptcha")) {
        await waitForManualFix(page, "Amazon is showing a captcha. Solve it in the browser, then come back here.", target);
        continue;
      }
      await waitForManualFix(page, `The order page for ${options.orderNumber} wasn't detected. Open it in the browser window, then come back here.`, target);
    }

    await page.waitForTimeout(800);
    const extracted = await extractOrderItems(page);

    // Keep a copy of the last order page so the price reader can be checked against Amazon's real layout.
    const debugDir = join(config.dataDir, "debug");
    await ensureDir(debugDir);
    await writeFile(join(debugDir, "last-order-page.html"), await page.content(), "utf8");

    if (options.keepOpen) {
      console.log(`The order is open in the "${options.profile}" browser window. Close that window when you're done.`);
      while (!closed && context.pages().length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    return extracted;
  } finally {
    if (!closed) await context.close().catch(() => {});
  }
}
