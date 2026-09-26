// The connected wallet in the top bar: a small menu with the way to your own identity page
// (where the owner controls appear), cancelling unused permissions, and RainbowKit's account modal.
import { useEffect, useRef, useState } from 'react'
import { useWriteContract } from 'wagmi'
import { contractErrorText } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, CHAIN, readClient } from '../wagmiConfig'

export default function AccountMenu({ label, address, onIdentity, onWallet }) {
  const [open, setOpen] = useState(false)
  const [cancel, setCancel] = useState(null)   // null · 'ask' · { type, msg }
  const ref = useRef(null)
  const { writeContractAsync } = useWriteContract()

  useEffect(() => {
    if (!open) { setCancel(c => (c?.type === 'info' ? c : null)); return }
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    ref.current?.querySelector('[role=menuitem]')?.focus()
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const choose = (fn) => () => { setOpen(false); fn() }

  async function cancelPermissions() {
    setCancel({ type: 'info', msg: 'Confirm in your wallet…' })
    try {
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'cancelAuthorization', args: [], chainId: CHAIN.id })
      setCancel({ type: 'info', msg: 'Waiting for confirmation…' })
      const receipt = await readClient.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      setCancel(receipt.status === 'success'
        ? { type: 'ok', msg: 'Done: permissions you signed earlier can no longer be used.' }
        : { type: 'err', msg: 'The transaction failed, so nothing changed.' })
    } catch (err) {
      setCancel({ type: 'err', msg: contractErrorText(err) ?? err.shortMessage ?? 'Not sent.' })
    }
  }

  return (
    <div className="account-menu" ref={ref}>
      <button className="topbar-action-link topbar-connect-btn" onClick={() => setOpen(o => !o)}
        aria-haspopup="menu" aria-expanded={open} title={address}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="account-menu-list" role="menu">
          <button role="menuitem" className="account-menu-item" onClick={choose(onIdentity)}>My identity</button>
          <button role="menuitem" className="account-menu-item" onClick={choose(onWallet)}>Wallet</button>
          <button role="menuitem" className="account-menu-item" onClick={() => setCancel('ask')} aria-expanded={cancel === 'ask'}>Cancel unused permissions</button>
          {cancel === 'ask' && (
            <div className="account-menu-note">
              <p>Stops every permission you've signed that hasn't been used yet. It's a transaction, so your wallet pays a small fee.</p>
              <div className="account-menu-actions">
                <button className="btn btn-primary" onClick={cancelPermissions}>Cancel them</button>
                <button className="btn" onClick={() => setCancel(null)}>Keep</button>
              </div>
            </div>
          )}
          {cancel && cancel !== 'ask' && (
            <div className={`account-menu-note ${cancel.type}`} role="status">{cancel.msg}</div>
          )}
        </div>
      )}
    </div>
  )
}
