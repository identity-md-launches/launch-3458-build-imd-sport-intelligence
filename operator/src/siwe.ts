import { randomBytes } from "node:crypto";
import { verifyMessage, getAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import type { Store } from "./store.ts";
import type { OperatorConfig } from "./config.ts";

/** Sign-In with Ethereum (EIP-4361): single-use nonces, origin and chain checks, expiring sessions. */
export function issueNonce(store: Store, cfg: OperatorConfig, now = Date.now()): string {
  const nonce = randomBytes(16).toString("hex");
  store.tx((db) => {
    for (const [k, v] of Object.entries(db.nonces)) if (v.expiresAt < now) delete db.nonces[k];
    db.nonces[nonce] = { expiresAt: now + cfg.nonceTtlSeconds * 1000, origin: cfg.allowedOrigin };
  });
  return nonce;
}

export type SiweResult = { ok: true; token: string; address: string; expiresAt: number } | { ok: false; error: string };

export async function verifySignIn(store: Store, cfg: OperatorConfig, message: string, signature: `0x${string}`, requestOrigin: string, now = Date.now()): Promise<SiweResult> {
  const m = parseSiweMessage(message);
  if (!m.address || !m.nonce || !m.domain || !m.uri || !m.chainId) return { ok: false, error: "malformed_message" };
  if (!cfg.allowedOrigin || requestOrigin !== cfg.allowedOrigin) return { ok: false, error: "origin_not_allowed" };
  if (m.domain !== cfg.siweDomain) return { ok: false, error: "domain_mismatch" };
  if (new URL(m.uri).origin !== cfg.allowedOrigin) return { ok: false, error: "uri_mismatch" };
  if (m.chainId !== cfg.chainId) return { ok: false, error: "wrong_chain" };
  if (m.expirationTime && m.expirationTime.getTime() < now) return { ok: false, error: "message_expired" };
  if (m.notBefore && m.notBefore.getTime() > now) return { ok: false, error: "not_yet_valid" };
  const n = store.db.nonces[m.nonce];
  if (!n || n.expiresAt < now) return { ok: false, error: "unknown_or_expired_nonce" };
  const valid = await verifyMessage({ address: m.address, message, signature }).catch(() => false);
  if (!valid) return { ok: false, error: "bad_signature" };
  const token = randomBytes(32).toString("hex");
  const expiresAt = now + cfg.sessionTtlSeconds * 1000;
  store.tx((db) => {
    delete db.nonces[m.nonce!]; // single use, consumed only on success
    db.sessions[token] = { address: getAddress(m.address!), chainId: m.chainId!, expiresAt };
  });
  return { ok: true, token, address: getAddress(m.address), expiresAt };
}

export function sessionFor(store: Store, token: string | undefined, now = Date.now()): { address: string } | null {
  if (!token) return null;
  const s = store.db.sessions[token];
  if (!s) return null;
  if (s.expiresAt < now) { store.tx((db) => delete db.sessions[token]); return null; }
  return { address: s.address };
}
export function signOut(store: Store, token: string) { store.tx((db) => delete db.sessions[token]); }
