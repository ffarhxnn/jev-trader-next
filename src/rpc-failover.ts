export interface RpcReadResult<T> {
  value: T;
  endpointIndex: number;
}

export const DEFAULT_READ_RPC_TIMEOUT_MS = 5_000;

/** Bound stalled HTTP reads so the caller can fail over instead of freezing capture indefinitely. */
export function readRpcConnectionInfo(url: string, timeoutMs = DEFAULT_READ_RPC_TIMEOUT_MS) {
  if (!url || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Read-only RPC connections require a URL and a positive integer timeout.");
  }
  return { url, timeout: timeoutMs };
}

/** Try one endpoint at a time; a failed request never fans out to every public RPC. */
export async function readWithRpcFailover<P, T>(
  providers: readonly P[],
  preferredIndex: number,
  read: (provider: P, endpointIndex: number) => Promise<T>,
): Promise<RpcReadResult<T>> {
  if (!providers.length) throw new Error("At least one read-only RPC provider is required.");
  const start = Number.isSafeInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < providers.length ? preferredIndex : 0;
  let lastError: unknown;
  for (let offset = 0; offset < providers.length; offset++) {
    const endpointIndex = (start + offset) % providers.length;
    try {
      return { value: await read(providers[endpointIndex]!, endpointIndex), endpointIndex };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
