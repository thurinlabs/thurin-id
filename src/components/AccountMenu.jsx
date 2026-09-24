// The connected wallet in the top bar: a small menu with the way to your own identity page
// (where the owner controls appear) and RainbowKit's usual account modal (copy, disconnect).
import { useEffect, useRef, useState } from 'react'

export default function AccountMenu({ label, address, onIdentity, onWallet }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus() } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    ref.current?.querySelector('[role=menuitem]')?.focus()
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const choose = (fn) => () => { setOpen(false); fn() }

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
        </div>
      )}
    </div>
  )
}
