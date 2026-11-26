/** Release settings, fixed at build time. Empty values switch their feature off. */
const env = import.meta.env as Record<string, string | undefined>;
const origin = (env.VITE_COMPANION_ORIGIN ?? "").trim().replace(/\/$/, "");
export const COMPANION_ORIGIN = /^https:\/\/[^/]+$/.test(origin) ? origin : "";
export const WALLETCONNECT_PROJECT_ID = (env.VITE_WALLETCONNECT_PROJECT_ID ?? "").trim();
export const SITE = {
  name: "IMD Sport Intelligence",
  description: "Sports analysis with pre-match probabilities scored against real results. Analysis only, no wagering.",
};
export const TOKEN = { address: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7" as const, chainId: 1, decimals: 18, symbol: "IMD" };
export const LEG_UNITS = 500000000000000000n;
