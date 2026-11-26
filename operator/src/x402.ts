import { createHash } from "node:crypto";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { LocalAccount } from "viem/accounts";
import type { Payer, Challenge } from "./swarm.ts";

/**
 * Operator-side signer for IMD paid requests, following https://imd.fun/docs/api/ ("POST
 * /requests/:id/submit", "The payment payload", "The quote approval") and GET /openapi.json
 * (x-imd-quote-approval). The documented client flow: the x402 v2 Permit2 payment is built by
 * @x402/core + @x402/evm (pinned 2.28.0, the version the plane pins), its `extensions` dropped,
 * `accepted` set to the challenge's accepts[0]; then the same wallet signs the EIP-712
 * QuoteApproval whose every field comes from the 402 challenge JSON (resourceUrl,
 * requesterScopeHash, quote) or from that exact payment. The key stays with the operator
 * (IMD_SWARM_SIGNER_KEY); nothing here is shipped to the static site.
 */

/** Canonical JSON: object keys sorted recursively, no whitespace (the docs' `canon`). */
export function canonicalJson(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const paymentHash = (payment: unknown) => ("0x" + createHash("sha256").update(canonicalJson(payment)).digest("hex")) as `0x${string}`;

/** The documented payment payload shape. The server parses it strictly: any other key, at any depth, is invalid_payment_shape. */
const SHAPE = {
  x402Version: true,
  resource: { url: true, description: true, mimeType: true },
  accepted: { scheme: true, network: true, asset: true, amount: true, payTo: true, maxTimeoutSeconds: true, extra: { assetTransferMethod: true } },
  payload: { signature: true, permit2Authorization: { from: true, permitted: { token: true, amount: true }, spender: true, nonce: true, deadline: true, witness: { to: true, validAfter: true } } },
  extensions: {},
} as const;
type Shape = { [k: string]: true | Shape };
export function shapeProblems(v: unknown, shape: Shape = SHAPE as unknown as Shape, at = ""): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [`${at || "payment"} is not an object`];
  const out: string[] = [];
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const s = shape[k]; const path = at ? `${at}.${k}` : k;
    if (!s) { out.push(`unknown key ${path}`); continue; }
    if (s !== true) out.push(...shapeProblems(x, s, path));
  }
  return out;
}
const REQUIRED = ["x402Version", "accepted", "payload"];

export const QUOTE_APPROVAL_TYPES = {
  QuoteApproval: [
    { name: "resource", type: "string" }, { name: "requesterScopeHash", type: "bytes32" }, { name: "quoteId", type: "string" }, { name: "quoteHash", type: "bytes32" }, { name: "paymentHash", type: "bytes32" },
    { name: "action", type: "string" }, { name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "payTo", type: "address" }, { name: "expiresAt", type: "uint256" },
  ],
} as const;
const hex32 = (h: string, what: string) => { const x = h.startsWith("0x") ? h : `0x${h}`; if (!/^0x[0-9a-fA-F]{64}$/.test(x)) throw new Error(`challenge ${what} is not a 32-byte hash`); return x as `0x${string}`; };

/** The QuoteApproval message, field by field from the challenge JSON and the exact payment. */
export function quoteApprovalMessage(ch: Challenge, payment: unknown) {
  const q = ch.quote;
  return {
    resource: ch.resourceUrl, requesterScopeHash: hex32(ch.requesterScopeHash, "requesterScopeHash"), quoteId: q.id, quoteHash: hex32(q.quoteHash, "quote.quoteHash"),
    paymentHash: paymentHash(payment), action: q.action, asset: q.payment.asset as `0x${string}`, amount: BigInt(q.payment.amount), payTo: q.payment.payTo as `0x${string}`, expiresAt: BigInt(q.expiresAt),
  };
}
export const quoteApprovalDomain = (ch: Challenge) => ({ name: "IdentityMD Paid Action", version: "1", chainId: Number(ch.quote.payment.network.slice("eip155:".length)) });

/**
 * Build both signatures for one order. Checks the challenge against the saved order before signing
 * anything: same order id, accepts[0] matching the quote's payment terms and the reserved amount,
 * Permit2 as the transfer method, and a permit deadline before quote.expiresAt.
 */
export function swarmPayer(account: LocalAccount): Payer {
  return async ({ orderId, challenge: ch, expectedAmount }) => {
    const req = ch?.accepts?.[0];
    if (!req) throw new Error("402 challenge carried no payment requirements");
    const q = ch.quote;
    if (!q || q.id !== orderId) throw new Error("challenge quote does not belong to this order");
    if (!ch.resourceUrl || !ch.requesterScopeHash) throw new Error("challenge JSON lacks resourceUrl or requesterScopeHash");
    if (req.scheme !== "exact" || req.extra?.assetTransferMethod !== "permit2") throw new Error("challenge is not an exact Permit2 payment");
    const lc = (s: string) => String(s).toLowerCase();
    if (req.network !== q.payment.network || lc(req.asset) !== lc(q.payment.asset) || lc(req.payTo) !== lc(q.payment.payTo) || String(req.amount) !== String(q.payment.amount)) throw new Error("challenge requirements differ from the saved quote");
    if (BigInt(q.payment.amount) !== expectedAmount) throw new Error(`quote amount ${q.payment.amount} is not the reserved ${expectedAmount}`);
    if (ch.resource?.url && ch.resource.url !== ch.resourceUrl) throw new Error("challenge resource.url differs from resourceUrl");
    const client = x402Client.fromConfig({
      spendControls: { allowedAssets: [{ network: req.network as `${string}:${string}`, asset: req.asset, maxAmountPerPayment: String(expectedAmount) }] },
      schemes: [{ network: req.network as `${string}:${string}`, client: new ExactEvmScheme(account) }],
    });
    const { extensions: _drop, ...generated } = (await client.createPaymentPayload({ x402Version: 2, resource: ch.resource, accepts: [req] } as any)) as any;
    const payment = JSON.parse(JSON.stringify({ ...generated, accepted: req }));
    const problems = [...shapeProblems(payment), ...REQUIRED.filter((k) => !(k in payment)).map((k) => `missing ${k}`)];
    if (problems.length) throw new Error(`payment payload outside the documented shape: ${problems.join(", ")}`);
    if (BigInt(payment.payload.permit2Authorization.deadline) >= BigInt(q.expiresAt)) throw new Error("permit deadline is not before quote.expiresAt; request a new quote");
    const quoteSignature = await account.signTypedData({ domain: quoteApprovalDomain(ch), types: QUOTE_APPROVAL_TYPES, primaryType: "QuoteApproval", message: quoteApprovalMessage(ch, payment) });
    return { payment, paymentHeader: encodePaymentSignatureHeader(payment), quoteSignature };
  };
}
