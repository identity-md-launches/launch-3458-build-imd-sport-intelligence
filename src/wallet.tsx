import { useEffect, useRef, useState } from "react";
import { createConfig, http, useAccount, useConnect, useDisconnect, useSwitchChain, type Connector } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { mainnet } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { SITE, WALLETCONNECT_PROJECT_ID, COMPANION_ORIGIN } from "./release";
import { api, session } from "./companion";

export const config = createConfig({
  chains: [mainnet],
  multiInjectedProviderDiscovery: true, // EIP-6963: MetaMask, Rabby and others listed by name
  connectors: [
    injected(),
    ...(WALLETCONNECT_PROJECT_ID ? [walletConnect({ projectId: WALLETCONNECT_PROJECT_ID, showQrModal: true, metadata: { name: SITE.name, description: SITE.description, url: location.origin, icons: [new URL("favicon.svg", location.href).href] } })] : []),
  ],
  transports: { [mainnet.id]: http("https://ethereum-rpc.publicnode.com") },
});

const WC_ICON = `<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" fill="#3B99FC"/><path d="M8.39 10.37c3.1-3.1 8.12-3.1 11.22 0l.37.38a.4.4 0 0 1 0 .56l-1.27 1.27a.2.2 0 0 1-.28 0l-.52-.51a5.5 5.5 0 0 0-7.82 0l-.55.55a.2.2 0 0 1-.28 0L7.98 11.34a.4.4 0 0 1 0-.56l.41-.41Zm13.86 2.64 1.13 1.14a.4.4 0 0 1 0 .56l-5.12 5.12a.4.4 0 0 1-.56 0l-3.63-3.63a.1.1 0 0 0-.14 0l-3.63 3.63a.4.4 0 0 1-.56 0l-5.12-5.12a.4.4 0 0 1 0-.56l1.13-1.14a.4.4 0 0 1 .57 0l3.63 3.64a.1.1 0 0 0 .14 0l3.63-3.64a.4.4 0 0 1 .57 0l3.63 3.64a.1.1 0 0 0 .14 0l3.63-3.64a.4.4 0 0 1 .56 0Z" fill="#fff"/></svg>`;
const MM_LINK = (url: string) => `https://link.metamask.io/dapp/${url.replace(/^https?:\/\//, "")}`;
const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !(window as unknown as { ethereum?: unknown }).ethereum;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ConnectSheet() {
  const mobile = isMobile();
  // useAccount().chainId is the wallet's actual chain, even one this config does not list (useChainId is not).
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { connectors, connect, isPending, variables, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const dlg = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // A native modal dialog keeps Tab inside the sheet; Escape and Close both end in onClose, which returns focus.
  useEffect(() => { const d = dlg.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  useEffect(() => { if (isConnected) setOpen(false); }, [isConnected]);
  const named = connectors.some((c) => c.type === "injected" && c.id !== "injected");
  const listed = [...connectors.filter((c) => c.type === "injected"), ...connectors.filter((c) => c.type !== "injected")].filter((c) => !(c.id === "injected" && named));
  const label = (c: Connector) => (c.id === "injected" ? "Browser wallet" : c.name);
  const icon = (c: Connector) => c.icon ?? (c.id === "walletConnect" ? `data:image/svg+xml;utf8,${encodeURIComponent(WC_ICON)}` : undefined);
  const onClose = () => { setOpen(false); setTimeout(() => trigger.current?.focus(), 0); };
  return (
    <>
      {isConnected && address ? (
        chainId !== mainnet.id
          ? <button ref={trigger} className="btn btn-gold" onClick={() => switchChain({ chainId: mainnet.id })}>Switch to Ethereum</button>
          : <button ref={trigger} className="btn btn-quiet" onClick={() => { disconnect(); session.clear(); }} title="Disconnect"><span className="mono">{short(address)}</span> · Disconnect</button>
      ) : <button ref={trigger} className="btn btn-quiet" onClick={() => setOpen(true)}>Connect</button>}
      <dialog ref={dlg} className="sheet" aria-labelledby="connect-title" onClose={onClose} onClick={(e) => { if (e.target === dlg.current) dlg.current.close(); }}>
        {open && (
          <>
            <div className="sheet-head"><h2 id="connect-title">Connect a wallet</h2><button className="x" aria-label="Close" onClick={() => dlg.current?.close()} autoFocus>×</button></div>
            <p className="muted small">Connecting is free. It is only needed to sign in for purchase history and receipts.</p>
            {mobile && <a className="row" href={MM_LINK(location.href)}><span className="ic" aria-hidden>M</span><span>Open in MetaMask</span></a>}
            {listed.filter((c) => !mobile || c.type !== "injected").map((c) => (
              <button className="row" key={c.uid} onClick={() => connect({ connector: c })} disabled={isPending}>
                <span className="ic">{icon(c) ? <img width={28} height={28} src={icon(c)} alt="" /> : null}</span>
                <span>{label(c)}{isPending && variables?.connector === c ? " · opening…" : ""}</span>
              </button>
            ))}
            {!listed.length && !mobile && <p className="muted small">No browser wallet found. Install MetaMask or Rabby, then reload.</p>}
            {error && <p className="note" role="status">{error.message.split("\n")[0]}</p>}
          </>
        )}
      </dialog>
    </>
  );
}

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<any> };
async function provider(): Promise<Eip1193 | null> {
  const { getAccount } = await import("wagmi/actions");
  const c = getAccount(config).connector; return c ? ((await c.getProvider()) as Eip1193) : null;
}

/** SIWE sign-in against the operator companion: nonce from the server, origin and chain checked there. */
export async function signIn(address: `0x${string}`): Promise<string | null> {
  if (!COMPANION_ORIGIN) return "Sign-in needs the companion service, which is not configured for this release.";
  const n = await api<{ nonce: string; domain: string; chainId: number }>("/api/siwe/nonce");
  if (!n.ok) return "The companion service did not answer.";
  const message = createSiweMessage({ address, chainId: n.data.chainId, domain: location.host, uri: location.origin, nonce: n.data.nonce, version: "1", statement: "Sign in to IMD Sport Intelligence.", issuedAt: new Date(), expirationTime: new Date(Date.now() + 10 * 60_000) });
  const p = await provider(); if (!p) return "No wallet connected.";
  const signature = await p.request({ method: "personal_sign", params: [message, address] });
  const v = await api<{ ok: boolean; token?: string; error?: string }>("/api/siwe/verify", { method: "POST", body: JSON.stringify({ message, signature }) });
  if (!v.ok || !v.data.token) return `Sign-in refused: ${v.data.error ?? "unknown"}`;
  session.set(v.data.token, address); return null;
}

/** Broadcast hashes not yet verified, kept per intent so an interruption never asks for the same transfer again. */
const PKEY = (intentId: string) => `imd-sport-pending:${intentId}`;
export const pendingHashes = {
  get: (intentId: string): Record<string, string> => { try { return JSON.parse(localStorage.getItem(PKEY(intentId)) ?? "{}"); } catch { return {}; } },
  set: (intentId: string, legs: string[], hash: string) => { const m = pendingHashes.get(intentId); legs.forEach((l) => (m[l] = hash)); localStorage.setItem(PKEY(intentId), JSON.stringify(m)); },
  drop: (intentId: string, legs: string[]) => { const m = pendingHashes.get(intentId); legs.forEach((l) => delete m[l]); if (Object.keys(m).length) localStorage.setItem(PKEY(intentId), JSON.stringify(m)); else localStorage.removeItem(PKEY(intentId)); },
};
export type LegReply = { ok: boolean; verified: string[]; entitled?: boolean; error?: string; pending?: boolean };
const PENDING_ERRORS = new Set(["receipt_not_found", "not_final", "receipt_not_canonical"]);
export const postLeg = (intentId: string, txHash: string) => api<LegReply>(`/api/intents/${intentId}/legs`, { method: "POST", body: JSON.stringify({ txHash }) });

/**
 * Wallet batches (EIP-5792) sent but not yet landed, kept per intent from the moment
 * wallet_sendCalls returns, so a reload resumes polling the same batch and never sends a second.
 */
const BKEY = (intentId: string) => `imd-sport-batch:${intentId}`;
export type PendingBatch = { id: string; legs: string[]; sentAt: number };
export const pendingBatch = {
  get: (intentId: string): PendingBatch | null => { try { return JSON.parse(localStorage.getItem(BKEY(intentId)) ?? "null"); } catch { return null; } },
  set: (intentId: string, b: PendingBatch) => localStorage.setItem(BKEY(intentId), JSON.stringify(b)),
  drop: (intentId: string) => localStorage.removeItem(BKEY(intentId)),
};
/** EIP-5792 status: 1xx pending, 200 confirmed, 4xx/5xx failed (older wallets answer strings). */
const batchState = (st: any): "pending" | "confirmed" | "failed" => {
  const c = st?.status;
  if (c === 200 || c === "CONFIRMED" || c === "confirmed") return "confirmed";
  if ((typeof c === "number" && c >= 400) || c === "FAILED" || c === "failed") return "failed";
  return "pending";
};
/**
 * Ask the wallet once about the intent's pending batch. Confirmed receipts move to the hash list
 * for verification against the same intent; a failed batch frees its legs; otherwise they stay held.
 */
export async function checkBatch(intentId: string, p?: Eip1193 | null): Promise<"none" | "pending" | "landed" | "failed"> {
  const b = pendingBatch.get(intentId); if (!b) return "none";
  p ??= await provider().catch(() => null);
  if (!p) return "pending";
  let st: any; try { st = await p.request({ method: "wallet_getCallsStatus", params: [b.id] }); } catch { return "pending"; }
  const hashes: string[] = [...new Set<string>((st?.receipts ?? []).map((r: { transactionHash: string }) => r.transactionHash).filter(Boolean))];
  const state = batchState(st);
  if (hashes.length && state !== "failed") { hashes.forEach((h) => pendingHashes.set(intentId, b.legs, h)); pendingBatch.drop(intentId); return "landed"; }
  if (state === "failed") { pendingBatch.drop(intentId); return "failed"; }
  return "pending";
}

/** Re-verify every persisted hash and batch before anything new is requested. Returns legs still waiting. */
export async function reconcilePending(intentId: string): Promise<{ entitled: boolean; waiting: string[]; errors: string[] }> {
  let entitled = false; const errors: string[] = [];
  const batch = await checkBatch(intentId);
  if (batch === "failed") errors.push("The wallet reports the batch failed; nothing was charged by it. You can pay again.");
  const byHash = new Map<string, string[]>();
  for (const [leg, h] of Object.entries(pendingHashes.get(intentId))) byHash.set(h, [...(byHash.get(h) ?? []), leg]);
  for (const [h, legs] of byHash) {
    const r = await postLeg(intentId, h);
    if (r.data?.ok) { pendingHashes.drop(intentId, legs); entitled ||= !!r.data.entitled; }
    else if (r.status === 0 || PENDING_ERRORS.has(r.data?.error ?? "") || r.data?.pending) continue; // keep waiting; never re-request this leg
    else { pendingHashes.drop(intentId, legs); errors.push(`${legs.join(" and ")} transfer: ${r.data?.error ?? "refused"}`); }
  }
  const held = pendingBatch.get(intentId)?.legs ?? [];
  return { entitled, waiting: [...new Set([...Object.keys(pendingHashes.get(intentId)), ...held])], errors };
}

async function ensureMainnet(p: Eip1193) {
  const id = await p.request({ method: "eth_chainId" });
  if (Number(id) !== mainnet.id) throw new Error("Your wallet is not on Ethereum Mainnet. Use Switch to Ethereum, then try again.");
}

/**
 * Pay the given (unpaid, not pending) legs of an intent. Atomic batch (EIP-5792 wallet_sendCalls)
 * when the wallet reports it; otherwise one confirmation per leg. Every hash is persisted before it
 * is verified, and the chain is re-checked right before each wallet request.
 */
export async function payLegs(intentId: string, from: string, calls: { to: string; data: string; leg: string }[], onStep: (s: string) => void) {
  const p = await provider(); if (!p) throw new Error("No wallet connected.");
  await ensureMainnet(p);
  let atomic = false;
  try { const caps = await p.request({ method: "wallet_getCapabilities", params: [from, ["0x1"]] }); const c = caps?.["0x1"] ?? caps?.[1]; atomic = c?.atomic?.status === "supported" || c?.atomic?.status === "ready" || c?.atomicBatch?.supported === true; } catch { atomic = false; }
  if (pendingBatch.get(intentId)) throw new Error("A wallet batch for this purchase is still pending. Check it again instead of paying.");
  if (atomic && calls.length > 1) {
    onStep("Confirm one batch in your wallet");
    await ensureMainnet(p);
    const r = await p.request({ method: "wallet_sendCalls", params: [{ version: "2.0.0", chainId: "0x1", from, atomicRequired: true, calls: calls.map((c) => ({ to: c.to, data: c.data, value: "0x0" })) }] });
    const id = typeof r === "string" ? r : r?.id;
    if (!id) throw new Error("The wallet did not return a batch id.");
    // Persist before polling: a reload from here on resumes this batch instead of sending another.
    pendingBatch.set(intentId, { id, legs: calls.map((c) => c.leg), sentAt: Date.now() });
    onStep("Batch sent. Waiting for the wallet to report its transaction");
    for (let i = 0; i < 40; i++) {
      const s = await checkBatch(intentId, p);
      if (s === "landed") { onStep("Sent. Waiting for Ethereum finality, then verifying"); return; }
      if (s === "failed") throw new Error("The wallet reports the batch failed. Nothing was charged by it.");
      await new Promise((res) => setTimeout(res, 3000));
    }
    return; // still pending: its legs stay held, and reopening this prediction checks the same batch
  }
  for (const [i, c] of calls.entries()) {
    onStep(`Confirm transfer ${i + 1} of ${calls.length} in your wallet (${c.leg === "developer" ? "developer" : "Swarm research"} leg)`);
    await ensureMainnet(p);
    const hash = await p.request({ method: "eth_sendTransaction", params: [{ from, to: c.to, data: c.data, value: "0x0", chainId: "0x1" }] });
    pendingHashes.set(intentId, [c.leg], hash);
  }
}
