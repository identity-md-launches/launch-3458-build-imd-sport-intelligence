import { useEffect, useState } from "react";
import { createConfig, http, useAccount, useConnect, useDisconnect, useChainId, useSwitchChain, type Connector } from "wagmi";
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
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { connectors, connect, isPending, variables, error } = useConnect();
  const { disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [open]);
  useEffect(() => { if (isConnected) setOpen(false); }, [isConnected]);
  const named = connectors.some((c) => c.type === "injected" && c.id !== "injected");
  const listed = [...connectors.filter((c) => c.type === "injected"), ...connectors.filter((c) => c.type !== "injected")].filter((c) => !(c.id === "injected" && named));
  const label = (c: Connector) => (c.id === "injected" ? "Browser wallet" : c.name);
  const icon = (c: Connector) => c.icon ?? (c.id === "walletConnect" ? `data:image/svg+xml;utf8,${encodeURIComponent(WC_ICON)}` : undefined);
  if (isConnected && address) {
    if (chainId !== mainnet.id) return <button className="btn btn-gold" onClick={() => switchChain({ chainId: mainnet.id })}>Switch to Ethereum</button>;
    return <button className="btn btn-quiet" onClick={() => { disconnect(); session.clear(); }} title="Disconnect"><span className="mono">{short(address)}</span> · Disconnect</button>;
  }
  return (
    <>
      <button className="btn btn-quiet" onClick={() => setOpen(true)}>Connect</button>
      {open && (
        <div className="sheet-bg" onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><h2>Connect a wallet</h2><button className="x" aria-label="Close" onClick={() => setOpen(false)} autoFocus>×</button></div>
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
          </div>
        </div>
      )}
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
  session.set(v.data.token); return null;
}

/**
 * Pay the missing legs of an intent. Atomic batch (EIP-5792 wallet_sendCalls) when the wallet
 * reports it; otherwise one confirmation per leg. Each hash goes to the verifier as it lands, so an
 * interrupted purchase keeps its verified half.
 */
export async function payLegs(intentId: string, from: string, calls: { to: string; data: string; leg: string }[], onStep: (s: string) => void) {
  const p = await provider(); if (!p) throw new Error("No wallet connected.");
  let atomic = false;
  try { const caps = await p.request({ method: "wallet_getCapabilities", params: [from, ["0x1"]] }); const c = caps?.["0x1"] ?? caps?.[1]; atomic = c?.atomic?.status === "supported" || c?.atomic?.status === "ready" || c?.atomicBatch?.supported === true; } catch { atomic = false; }
  const post = (txHash: string) => api<{ ok: boolean; verified: string[]; entitled?: boolean; error?: string }>(`/api/intents/${intentId}/legs`, { method: "POST", body: JSON.stringify({ txHash }) });
  if (atomic && calls.length > 1) {
    onStep("Confirm one batch in your wallet");
    const { id } = await p.request({ method: "wallet_sendCalls", params: [{ version: "2.0.0", chainId: "0x1", from, atomicRequired: true, calls: calls.map((c) => ({ to: c.to, data: c.data, value: "0x0" })) }] });
    for (let i = 0; i < 120; i++) {
      const s = await p.request({ method: "wallet_getCallsStatus", params: [id] });
      const hashes: string[] = [...new Set<string>((s?.receipts ?? []).map((r: { transactionHash: string }) => r.transactionHash))];
      if (hashes.length) { onStep("Waiting for finality, then verifying"); return Promise.all(hashes.map(post)); }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error("The batch has not landed yet. Reopen this prediction to resume.");
  }
  const out = [];
  for (const [i, c] of calls.entries()) {
    onStep(`Confirm transfer ${i + 1} of ${calls.length} in your wallet (${c.leg} leg)`);
    const hash = await p.request({ method: "eth_sendTransaction", params: [{ from, to: c.to, data: c.data, value: "0x0" }] });
    out.push(await post(hash));
  }
  return out;
}
