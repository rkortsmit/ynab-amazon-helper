import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./utils.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

export type AppConfig = {
  rootDir: string;
  dataDir: string;
  profilesDir: string;
  ynabAccessToken: string | null;
  defaultPlanId: string;
  defaultAccountId: string | null;
  defaultAccountName: string | null;
  defaultMarketplace: string;
};

export async function loadConfig(): Promise<AppConfig> {
  const dataDir = join(rootDir, "data");
  const profilesDir = join(rootDir, "profiles");

  await ensureDir(dataDir);
  await ensureDir(profilesDir);

  return {
    rootDir,
    dataDir,
    profilesDir,
    ynabAccessToken: process.env.YNAB_ACCESS_TOKEN ?? null,
    defaultPlanId: process.env.YNAB_PLAN_ID ?? "last-used",
    defaultAccountId: process.env.YNAB_ACCOUNT_ID ?? null,
    defaultAccountName: process.env.YNAB_ACCOUNT_NAME ?? null,
    defaultMarketplace: process.env.AMAZON_MARKETPLACE ?? "https://www.amazon.com",
  };
}
