import { createHash, randomBytes } from "node:crypto";
import type { LocalAccount } from "viem/accounts";
import type { Payer } from "./swarm.ts";

/**
 * Operator-side signer for IMD paid requests (https://imd.fun/docs/api/, "How paying works"). The
 * same wallet signs (1) the x402 Permit2 payment named by the 402 PAYMENT-REQUIRED challenge and
 * (2) the EIP-712 QuoteApproval binding the quote to that exact payment. The key stays with the
 * operator (IMD_SWARM_SIGNER_KEY); nothing here is shipped to the static site.
 */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const b32 = (h: unknown) => { const s = String(h ?? ""); const x = s.startsWith("0x") ? s : "0x" + s; if (!/^0x[0-9a-fA-F]{64}$/.test(x)) throw new Error("expected a 32-byte hash, got " + s); return x as `0x${string}`; };

export function swarmPayer(account: LocalAccount, chainId: number, now = () => Math.floor(Date.now() / 1000)): Payer {
  return async ({ order, paymentRequired, resourceUrl }) => {
    const req = (paymentRequired?.accepts ?? [])[0];
    if (!req) throw new Error("402 challenge carried no payment requirements");
    const spender = req.extra?.spender ?? req.extra?.permit2Spender ?? req.extra?.proxy;
    if (!spender) throw new Error("402 challenge did not name the Permit2 spender");
    const t = now();
    const authorization = {
      from: account.address,
      permitted: { token: req.asset, amount: String(req.amount ?? req.maxAmountRequired) },
      spender, nonce: BigInt("0x" + randomBytes(32).toString("hex")).toString(), deadline: String(t + Number(req.maxTimeoutSeconds ?? 600)),
      witness: { to: req.payTo, validAfter: String(t - 60), extra: "0x" },
    };
    const signature = await account.signTypedData({
      domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 },
      types: {
        PermitWitnessTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "witness", type: "Witness" }],
        TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
        Witness: [{ name: "to", type: "address" }, { name: "validAfter", type: "uint256" }, { name: "extra", type: "bytes" }],
      },
      primaryType: "PermitWitnessTransferFrom",
      message: { permitted: { token: req.asset, amount: BigInt(authorization.permitted.amount) }, spender, nonce: BigInt(authorization.nonce), deadline: BigInt(authorization.deadline), witness: { to: req.payTo, validAfter: BigInt(authorization.witness.validAfter), extra: "0x" } },
    });
    const payment = { x402Version: paymentRequired.x402Version ?? 2, resource: paymentRequired.resource, accepted: req, payload: { signature, permit2Authorization: authorization } };
    const paymentHash = ("0x" + createHash("sha256").update(canonicalJson(payment)).digest("hex")) as `0x${string}`;
    const q = order?.quote ?? {};
    const quoteSignature = await account.signTypedData({
      domain: { name: "IdentityMD Paid Action", version: "1", chainId },
      types: { QuoteApproval: [{ name: "resource", type: "string" }, { name: "requesterScopeHash", type: "bytes32" }, { name: "quoteId", type: "string" }, { name: "quoteHash", type: "bytes32" }, { name: "paymentHash", type: "bytes32" }, { name: "action", type: "string" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "payTo", type: "address" }, { name: "expiresAt", type: "uint256" }] },
      primaryType: "QuoteApproval",
      message: { resource: resourceUrl, requesterScopeHash: b32(q.requesterScopeHash ?? order?.requesterScopeHash), quoteId: String(q.id ?? order?.id), quoteHash: b32(q.hash ?? q.quoteHash), paymentHash, action: String(order?.action ?? "job.open"), asset: req.asset, amount: BigInt(authorization.permitted.amount), payTo: req.payTo, expiresAt: BigInt(q.expiresAt ? Math.floor(new Date(q.expiresAt).getTime() / (String(q.expiresAt).match(/^\d+$/) ? 1 : 1000)) : t + 600) },
    });
    return { paymentHeader: Buffer.from(JSON.stringify(payment)).toString("base64"), quoteSignature };
  };
}
