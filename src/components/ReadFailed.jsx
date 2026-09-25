// When a read fails, say whose fault it is: "no address" or zero claims reads as a fact about the
// identity. So after a failed read (or an empty ENS result) ask the RPC one cheap question; if
// that fails too, the RPC is down and nothing about the identity is known.
import { useEffect, useState } from 'react'
import { createPublicClient, http } from 'viem'
import { CHAIN, RPC_URL, CUSTOM_RPC_URL, RPC_STORAGE_KEY, rpcProviderName } from '../wagmiConfig'

/** null while checking, then true (the RPC answers) or false (it doesn't). */
export function useRpcReachable(active) {
  const [reachable, setReachable] = useState(null)
  useEffect(() => {
    if (!active) { setReachable(null); return }
    let cancelled = false
    setReachable(null)
    createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { timeout: 8_000, retryCount: 0 }) })
      .getBlockNumber()
      .then(() => { if (!cancelled) setReachable(true) }, () => { if (!cancelled) setReachable(false) })
    return () => { cancelled = true }
  }, [active])
  return reachable
}

function resetToDefaultRpc() {
  try { localStorage.removeItem(RPC_STORAGE_KEY) } catch { /* storage blocked */ }
  window.location.reload()
}

export function RpcDown() {
  return (
    <div className="status err rpc-down" style={{ marginTop: 24 }}>
      <strong>Couldn't reach the RPC ({rpcProviderName(RPC_URL)}).</strong> Nothing was checked, so
      nothing here is known yet.{' '}
      <button className="rpc-down-action" onClick={() => window.location.reload()}>Try again</button>
      {CUSTOM_RPC_URL && <>{' · '}<button className="rpc-down-action" onClick={resetToDefaultRpc}>Use the default RPC</button></>}
    </div>
  )
}

/** A failed registry read: the RPC-down box, or one plain line (never viem's full dump). */
export function ReadFailed({ error }) {
  const reachable = useRpcReachable(!!error)
  if (!error || reachable === null) return <div className="status info" style={{ marginTop: 24 }}>Reading the registry…</div>
  if (!reachable) return <RpcDown />
  return <div className="status err" style={{ marginTop: 24 }}>Couldn't read the registry. Try again, or change the RPC in the footer.</div>
}

/** An ENS name that resolved to nothing, or that failed to resolve: only say "no address" if the RPC is up. */
export function EnsNotResolved({ name, error }) {
  const reachable = useRpcReachable(true)
  if (reachable === null) return <div className="status info" style={{ marginTop: 24 }}>Looking up {name}…</div>
  if (!reachable) return <RpcDown />
  if (error) return <div className="status err" style={{ marginTop: 24 }}>Couldn't look up that name. Try again, or change the RPC in the footer.</div>
  return <div className="status err" style={{ marginTop: 24 }}>No address found for {name}</div>
}
