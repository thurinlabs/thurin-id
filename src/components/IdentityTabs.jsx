// The identity page's tabs. Each tab is a route (/ens/<name>, /ens/<name>/claims,
// /ens/<name>/records) so every tab is a shareable URL; the bar reuses /attest's styles.

export const IDENTITY_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'claims', label: 'Claims' },
  { id: 'records', label: 'Records' },
]

export default function IdentityTabs({ tab, onTab, counts = {} }) {
  return (
    <div className="attest-tabs identity-tabs" role="tablist">
      {IDENTITY_TABS.map(t => (
        <button key={t.id} role="tab" aria-selected={tab === t.id} className={`attest-tab ${tab === t.id ? 'active' : ''}`} onClick={() => onTab(t.id)}>
          {t.label}{counts[t.id] > 0 && <span className="attest-tab-count">{counts[t.id]}</span>}
        </button>
      ))}
    </div>
  )
}
