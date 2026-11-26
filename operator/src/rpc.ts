/** Minimal JSON-RPC reader. Tests pass a fixture implementation of the same interface. */
export type Log = { address: string; topics: string[]; data: string; logIndex: string; transactionHash: string; blockNumber: string; removed?: boolean };
export type Receipt = { status: string; from: string; to: string | null; blockNumber: string; transactionHash: string; logs: Log[] };
export interface ChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<number>;
  receipt(hash: string): Promise<Receipt | null>;
  call(to: string, data: string): Promise<string>;
  code(address: string): Promise<string>;
}
export function httpReader(url: string, fetchImpl: typeof fetch = fetch): ChainReader {
  let id = 0;
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  return {
    chainId: async () => Number(await rpc("eth_chainId", [])),
    blockNumber: async () => Number(await rpc("eth_blockNumber", [])),
    receipt: async (h) => (await rpc("eth_getTransactionReceipt", [h])) as Receipt | null,
    call: async (to, data) => (await rpc("eth_call", [{ to, data }, "latest"])) as string,
    code: async (a) => (await rpc("eth_getCode", [a, "latest"])) as string,
  };
}
