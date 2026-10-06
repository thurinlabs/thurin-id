// Test harness for the QR device flow: mounts it alone (the attest page needs a connected wallet
// first) under the production CSP, and leaves the paste it produces on window for the test to read.
import { createRoot } from 'react-dom/client'
import { Suspense, lazy } from 'react'
import '../src/index.css'
import '../src/attest.css'

const QrSign = lazy(() => import('../src/components/QrSign'))
const address = new URLSearchParams(location.search).get('address') || '0x0000000000000000000000000000000000000001'

createRoot(document.getElementById('root')).render(
  <div className="attest-page" style={{ maxWidth: 760, margin: '24px auto', padding: 16 }}>
    <Suspense fallback={<p>Loading…</p>}>
      <QrSign address={address} onResult={text => { window.__qrResult = text }} onBack={() => {}} />
    </Suspense>
  </div>
)
