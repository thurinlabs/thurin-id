import { useState } from 'react'
import { useWriteContract } from 'wagmi'
import { createPublicClient, http, stringToHex } from 'viem'
import { recordKind } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, RPC_URL, CHAIN, EXPLORER_URL } from '../wagmiConfig'

// A plain (owner-signed-nothing-yet) set-record hand-off from `thurin record … --no-key`:
// the CLI prepared the value; the owner's wallet publishes it with setRecord.

function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '' }
function pretty(kind, value) {
  if (kind === 'thurin.pointer') {
    try { const p = JSON.parse(value); if (p.v === 1) return p.releases.map(r => `${r.name}  ${r.date}  sha256 ${r.sha256}`).join('\n') } catch { /* raw */ }
  }
  return value
}

export default function SetRecordPanel({ handoff: h, isConnected }) {
  const [status, setStatus] = useState(null)
  const [txHash, setTxHash] = useState(null)
  const [done, setDone] = useState(false)
  const { writeContractAsync } = useWriteContract()

  const publish = async () => {
    try {
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'setRecord', args: [BigInt(h.index), recordKind(h.kind), h.value ? stringToHex(h.value) : '0x'], chainId: CHAIN.id })
      setTxHash(hash)
      setStatus({ type: 'info', msg: `Waiting for confirmation… tx: ${hash.slice(0, 10)}…` })
      const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status === 'success') { setStatus({ type: 'ok', msg: '✓ Record set.' }); setDone(true) }
      else setStatus({ type: 'err', msg: `Transaction reverted. Tx: ${hash}` })
    } catch (err) {
      setStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  return (
    <div className={`step ${isConnected ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${isConnected && !done ? 'active-num' : ''}`}>02 //</span>
        <span className="step-title">{h.value ? 'Set a record' : 'Clear a record'} on claim #{h.index}</span>
        {done && <span className="step-badge">✓ set</span>}
      </div>
      <div className="fade-in">
        <div className="mono-box" style={{ marginBottom: 12 }}>
          <div className="label">What will be published</div>
          <div className="value">Owner: {h.owner}</div>
          <div className="value">Record: {h.kind}</div>
          <pre className="value" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{h.value ? pretty(h.kind, h.value) : '(clear)'}</pre>
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>{new TextEncoder().encode(h.value || '').length} bytes</div>
        </div>
        {done ? (
          <div className="row">
            <a href={`/eth/${h.owner}`} className="btn btn-primary" target="_blank" rel="noopener noreferrer">View identity</a>
            {txHash && EXPLORER_URL && <a href={`${EXPLORER_URL}/tx/${txHash}`} className="btn" target="_blank" rel="noopener noreferrer">View transaction</a>}
          </div>
        ) : (
          <button className="btn btn-primary" onClick={publish} disabled={!isConnected || status?.type === 'info'}>
            {status?.type === 'info' ? 'Publishing…' : `Set record from ${shortAddr(h.owner)}`}
          </button>
        )}
        {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      </div>
    </div>
  )
}
