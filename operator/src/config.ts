/** Operator settings. Everything owner-specific defaults to empty and keeps its feature off. */
export const IMD_TOKEN = {
  chainId: 1,
  address: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7" as `0x${string}`,
  decimals: 18,
  symbol: "IMD",
  /** Ethereum Mainnet entry of https://imd.fun/docs; verify-token.ts re-reads code and decimals. */
  docs: "https://imd.fun/docs",
};
/** 1 IMD per prediction version, paid as two direct 0.5 IMD ERC-20 transfers. */
export const PRICE_UNITS = 1_000_000_000_000_000_000n;
export const LEG_UNITS = 500_000_000_000_000_000n;

export type OperatorConfig = {
  allowedOrigin: string;          // the static site origin allowed to call this service (CORS + SIWE domain)
  siweDomain: string;             // host part of allowedOrigin
  chainId: number;
  rpcUrl: string;
  developerRecipient: string;     // empty until the operator sets it
  researchRecipient: string;      // empty until the operator sets it
  sessionTtlSeconds: number;
  nonceTtlSeconds: number;
  intentTtlSeconds: number;
  confirmations: number;          // blocks after which a Transfer log counts as final
  dataDir: string;                // private store, never published
  imdApi: string;                 // IMD Swarm API base
  imdPaidToken: string;           // bearer token for paid request routes, operator secret
  researchActivated: boolean;     // operator switch: research dispatch stays off until set
  feedKeys: Record<string, string>;
  port: number;
};

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

export function loadConfig(env: Record<string, string | undefined> = process.env): OperatorConfig {
  const allowedOrigin = env.IMD_SPORT_ALLOWED_ORIGIN ?? "";
  let siweDomain = "";
  try { siweDomain = allowedOrigin ? new URL(allowedOrigin).host : ""; } catch { siweDomain = ""; }
  return {
    allowedOrigin,
    siweDomain,
    chainId: Number(env.IMD_SPORT_CHAIN_ID ?? 1),
    rpcUrl: env.IMD_SPORT_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
    developerRecipient: env.IMD_SPORT_DEVELOPER_RECIPIENT ?? "",
    researchRecipient: env.IMD_SPORT_RESEARCH_RECIPIENT ?? "",
    sessionTtlSeconds: Number(env.IMD_SPORT_SESSION_TTL ?? 8 * 3600),
    nonceTtlSeconds: Number(env.IMD_SPORT_NONCE_TTL ?? 600),
    intentTtlSeconds: Number(env.IMD_SPORT_INTENT_TTL ?? 3600),
    confirmations: Number(env.IMD_SPORT_CONFIRMATIONS ?? 12),
    dataDir: env.IMD_SPORT_DATA_DIR ?? "./.operator-data",
    imdApi: env.IMD_API ?? "https://api.imd.fun",
    imdPaidToken: env.IMD_PAID_TOKEN ?? "",
    researchActivated: env.IMD_SPORT_RESEARCH_ACTIVE === "1",
    feedKeys: {
      sportradar: env.SPORTRADAR_API_KEY ?? "",
      sportsdataio: env.SPORTSDATAIO_API_KEY ?? "",
      apisports: env.APISPORTS_API_KEY ?? "",
    },
    port: Number(env.PORT ?? 8787),
  };
}

/** Which prerequisites are missing; checkout is only offered when this list is empty. */
export function checkoutBlockers(c: OperatorConfig, verifierOk: boolean, tokenVerified: boolean): string[] {
  const out: string[] = [];
  if (!c.allowedOrigin.startsWith("https://")) out.push("allowed HTTPS site origin not set");
  if (!isAddr(c.developerRecipient)) out.push("developer recipient not set");
  if (!isAddr(c.researchRecipient)) out.push("Swarm research recipient not set");
  if (isAddr(c.developerRecipient) && c.developerRecipient.toLowerCase() === c.researchRecipient.toLowerCase()) out.push("recipients must differ");
  if (!tokenVerified) out.push("IMD token not verified against the RPC");
  if (!verifierOk) out.push("receipt verifier RPC not answering on chain " + c.chainId);
  return out;
}
