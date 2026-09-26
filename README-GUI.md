# YNAB Amazon Helper – point-and-click edition

A local helper that matches your Amazon orders to your YNAB transactions, then lets you add
memos ("what did I actually buy?"), pick categories, and split multi-item charges, all from a
simple page in your browser.

Everything runs on your own computer. Your YNAB token, your Amazon logins and your order
history are saved only in this folder. Nothing is sent anywhere except to YNAB and Amazon
themselves.

This package builds on [deshazer/ynab-amazon-helper](https://github.com/deshazer/ynab-amazon-helper)
(MIT License, see `LICENSE`) and adds a local GUI, guided setup, memo-only updates, multiple Amazon
accounts, split transactions, and item prices from Amazon order pages.

## Quick start

**Windows:** unzip the folder somewhere simple (for example `C:\YNAB Amazon Helper`) and
double-click **Start GUI.bat**.

**Mac:** unzip, then double-click **start-gui.command** (the first time, right-click it and choose
Open if macOS warns about it). The Mac launcher hasn't been tested as much as the Windows one.

The first time, the launcher offers to install **Bun** (the free program that runs the helper,
[bun.sh](https://bun.sh)) and then downloads the helper's components. After that it opens the
helper in your browser on the **Setup** tab, which walks you through the rest:

1. **Browser for Amazon**: one click to install the separate browser the helper uses for Amazon.
2. **Connect YNAB**: create a personal access token in YNAB (web app → Account Settings →
   Developer Settings → New Token), paste it, pick your budget and the card you use for Amazon.
3. **Add your Amazon account(s)**: one per Amazon login that uses this card. A browser window
   opens and you sign in yourself (including any verification code). It's remembered.

Leave the black launcher window open while you use the helper, and close it to stop.

## Day to day

1. **Commands → Sync all accounts** (with "Run Analyze afterwards" on). This pulls your recent Amazon
   orders and your YNAB transactions that need attention: unapproved ones, plus approved ones
   with no category.
2. **Transactions tab**: for each charge you can
   - write a memo with the item names (**Preview memo / Write memo…**),
   - pick a category (**Save**; tick "remember" to reuse it for the same items later),
   - **Split…** a multi-item charge across categories. The helper fills in Amazon's item prices
     and spreads tax and shipping for you when it can.
3. **Commands → Apply categories**: preview, then send your choices to YNAB. Keep
   "Only the ones I chose" on to send just what you picked.

Every button that changes YNAB shows a preview first and asks before writing. Saving a category
or split on the Transactions tab only records it locally until you run Apply.

## Good to know

- **Transfers and tracking accounts are skipped.** They don't use categories in YNAB.
- **Item prices are best-effort.** Amazon's pages change, so if prices aren't recognized
  you'll see a message and can type amounts yourself.
- **Splits:** YNAB can turn an unsplit transaction into a split, but it can't edit an existing
  split through its API. Change those in YNAB itself.
- **Your files:** `.env` (YNAB token), `data/` (orders and analysis) and `profiles/` (Amazon logins)
  are private. Don't share them, and don't put this folder in a synced or shared drive if you'd
  rather those stay on one computer.
- The original command-line commands still work (`bun run start help`), and the upstream
  `README.md` documents them.
