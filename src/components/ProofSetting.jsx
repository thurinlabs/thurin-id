// Footer: whether proofs are checked on every page or only when asked. Saved in this browser only.
import { setAlwaysCheckProofs, useAlwaysCheckProofs } from '../proofChecks'

export default function ProofSetting() {
  const always = useAlwaysCheckProofs()
  return (
    <div className="rpc-setting">
      {always ? 'Proofs checked on every page' : 'Proofs checked when you ask'}
      {' · '}
      <button className="rpc-setting-toggle" onClick={() => setAlwaysCheckProofs(!always)}
        title="Checking asks each platform directly, so they see your IP and which identity you're looking at. Saved in this browser only.">
        {always ? 'Only when I ask' : 'Always check'}
      </button>
    </div>
  )
}
