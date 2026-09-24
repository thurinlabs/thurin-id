// Footer: which RPC sees this site's reads, and a way to use your own. The RPC learns your IP
// and every identity you look up; the choice is saved in this browser only.
import { useState } from 'react'
import { createPublicClient, http } from 'viem'
import {
  CHAIN, REGISTRY_ADDRESS, REGISTRY_ABI, DEFAULT_RPC_URL, CUSTOM_RPC_URL, RPC_URL, RPC_STORAGE_KEY,
  isUsableRpcUrl, rpcProviderName,
} from '../wagmiConfig'

// Right chain, and the registry answers: the site only makes plain contract reads, no logs.
async function testRpc(url) {
  const client = createPublicClient({ chain: CHAIN, transport: http(url, { timeout: 10_000, retryCount: 0 }) })
  const chainId = await client.getChainId()
  if (chainId !== CHAIN.id) throw new Error(`That RPC is on chain ${chainId}, not ${CHAIN.name}`)
  await client.readContract({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'attestationCount', args: ['0x0000000000000000000000000000000000000000'] })
  return client.getBlockNumber()
}

function save(url) {
  try {
    if (url) localStorage.setItem(RPC_STORAGE_KEY, url)
    else localStorage.removeItem(RPC_STORAGE_KEY)
  } catch { /* storage blocked: nothing to save */ }
  window.location.reload()
}

export default function RpcSetting() {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(CUSTOM_RPC_URL || '')
  const [status, setStatus] = useState(null)   // { ok, msg }
  const [busy, setBusy] = useState(false)

  const check = async () => {
    const u = url.trim()
    if (!isUsableRpcUrl(u)) { setStatus({ ok: false, msg: 'Enter an https:// RPC URL' }); return false }
    setBusy(true); setStatus(null)
    try {
      const block = await testRpc(u)
      setStatus({ ok: true, msg: `✓ ${CHAIN.name}, block ${block.toLocaleString()}` })
      return true
    } catch (e) {
      setStatus({ ok: false, msg: e.shortMessage || e.message || 'No answer from that RPC' })
      return false
    } finally { setBusy(false) }
  }

  return (
    <div className="rpc-setting">
      <span>
        Reads via {CUSTOM_RPC_URL ? `your RPC (${rpcProviderName(RPC_URL)})` : rpcProviderName(DEFAULT_RPC_URL)}
        {' · '}
        <button className="rpc-setting-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>{open ? 'Close' : 'Change'}</button>
      </span>
      {open && (
        <div className="rpc-setting-panel">
          <p>The RPC sees your IP and every identity you look up, and it's also where this site waits for your transactions to confirm. Your wallet sends them through its own RPC. Use your own node to keep all of that to yourself. Saved in this browser only.</p>
          <input type="url" value={url} placeholder="https://your-node.example/rpc" spellCheck={false}
            onChange={(e) => { setUrl(e.target.value); setStatus(null) }} aria-label="RPC URL" />
          <div className="rpc-setting-actions">
            <button className="btn btn-small" onClick={check} disabled={busy || !url.trim()}>{busy ? 'Testing…' : 'Test'}</button>
            <button className="btn btn-small" disabled={busy || !url.trim()} onClick={async () => { if (await check()) save(url.trim()) }}>Save</button>
            {CUSTOM_RPC_URL && <button className="btn btn-small" disabled={busy} onClick={() => save(null)}>Reset to default</button>}
          </div>
          {status && <div className={status.ok ? 'rpc-setting-ok' : 'rpc-setting-err'}>{status.msg}</div>}
        </div>
      )}
    </div>
  )
}
