import { useEffect, useState } from 'react'
import { normalize } from 'viem/ens'
import { useAccount, useEnsText, usePublicClient, useWriteContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { ENS_HINT_KEY, ensHintFor, ensHintWrite } from '@thurinlabs/identity-kit'
import { CHAIN, EXPLORER_URL, NETWORK } from '../wagmiConfig'

// One line under the current fingerprint: does the ENS name's `id.thurin` record point at
// this key? The record is a discovery hint for ENS viewers; the claim is the proof. When
// the connected wallet may write the name's resolver, the line grows a one-transaction
// "Set it". Who may write is decided by simulating setText, not by guessing ownership —
// that works for wrapped names, subnames, and ENSv2's per-account resolvers alike.
//
// The record is read with the app's own wagmi hook, not the kit's useEnsHint: the kit is
// linked from a sibling checkout, so its wagmi is a second copy with its own context.

const DOCS = 'https://docs.thurin.id/#/guides/ens-record'

function safeNormalize(name) { try { return normalize(name) } catch { return undefined } }

export default function EnsRecordLine({ ensName, fingerprint }) {
  const { data: record, isLoading: recordLoading, refetch } = useEnsText({ name: safeNormalize(ensName), key: ENS_HINT_KEY, chainId: CHAIN.id, query: { enabled: !!safeNormalize(ensName) } })
  // Dev server only (tree-shaken from production builds): `?ens-record=<value>` stands in for the
  // chain, to look at the three states without setting a real record. Empty value = not set.
  const override = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('ens-record') : null
  const hint = { ...ensHintFor(override ?? record ?? null, fingerprint), isLoading: override === null && recordLoading, refetch }
  const { address: wallet, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const client = usePublicClient({ chainId: CHAIN.id })
  const { writeContractAsync } = useWriteContract()
  const [canWrite, setCanWrite] = useState(null)   // null: not checked; { resolver }: this wallet may write; { denied: reason }: it may not
  const [status, setStatus] = useState(null)

  const needsWrite = hint.state !== 'match' && !!fingerprint && NETWORK === 'mainnet'

  useEffect(() => {
    let live = true
    setCanWrite(null)
    if (!needsWrite || !isConnected || !wallet || !client || hint.isLoading) return
    ;(async () => {
      try {
        const call = ensHintWrite(ensName, fingerprint)
        const resolver = await client.getEnsResolver({ name: call.name })
        await client.simulateContract({ address: resolver, abi: call.abi, functionName: call.functionName, args: call.args, account: wallet })
        if (live) setCanWrite({ resolver })
      } catch (err) {
        // Not this wallet's name (owner/manager only), or the simulation itself failed: keep the reason for the tooltip.
        const reason = err?.shortMessage || err?.message || String(err)
        console.warn(`[thurin] ${wallet} cannot set ${ENS_HINT_KEY} on ${ensName}: ${reason}`)
        if (live) setCanWrite({ denied: reason })
      }
    })()
    return () => { live = false }
  }, [needsWrite, isConnected, wallet, client, ensName, fingerprint, hint.isLoading, hint.record])

  const setIt = async () => {
    try {
      const call = ensHintWrite(ensName, fingerprint)
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({ address: canWrite.resolver, abi: call.abi, functionName: call.functionName, args: call.args, chainId: CHAIN.id })
      setStatus({ type: 'info', msg: `Waiting for confirmation… tx: ${hash.slice(0, 10)}…` })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status === 'success') { setStatus({ type: 'ok', msg: '✓ Record set.', hash }); hint.refetch() }
      else setStatus({ type: 'err', msg: `Transaction reverted. Tx: ${hash}` })
    } catch (err) {
      setStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  if (!ensName || hint.isLoading) return null

  // The badge carries the state: green (points at this key), red (points elsewhere), plain (not set).
  // The sentence lives in the hover; clicking the badge opens the guide.
  const tone = hint.state === 'match' ? 'verified' : hint.state === 'mismatch' ? 'unverified' : 'neutral'
  const title = hint.state === 'match' ? `${hint.key} on ${ensName} points at this key. The ENS record is a hint for ENS viewers; the claim above is the proof.`
    : hint.state === 'unset' ? `${ensName} has no ${hint.key} record. Optional: it lets ENS viewers find this claim; the claim above is the proof either way. To set it, connect the wallet that manages ${ensName}.`
    : `${hint.key} on ${ensName} does not point at this key. ${hint.reason}. Record: “${hint.record}”.`

  return (
    <div className="ens-record-line" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <a href={DOCS} target="_blank" rel="noopener noreferrer" className={`status-badge ${tone}`} title={title} style={{ textDecoration: 'none' }}>
        ens record
      </a>
      {needsWrite && status?.type !== 'ok' && (
        !isConnected ? (
          <button className="btn btn-small" onClick={openConnectModal} title={`Connect the wallet that manages ${ensName}`}>Connect to set it</button>
        ) : canWrite?.resolver ? (
          <button className="btn btn-small btn-primary" onClick={setIt} disabled={status?.type === 'info'}>{status?.type === 'info' ? 'Setting…' : 'Set it'}</button>
        ) : null   // connected but not the name's manager: nothing to show; the hover says who can set it, the console says why
      )}
      {status && (
        <span className={`status ${status.type}`} style={{ margin: 0, padding: '2px 8px' }}>
          {status.msg}{status.hash && EXPLORER_URL && <> · <a href={`${EXPLORER_URL}/tx/${status.hash}`} target="_blank" rel="noopener noreferrer">view</a></>}
        </span>
      )}
    </div>
  )
}
