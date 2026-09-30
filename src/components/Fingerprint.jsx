import { spacedFingerprint } from '../format'

/**
 * A fingerprint as two halves of groups of four, gpg's layout: one line when it fits, split
 * between the halves when it doesn't, never inside a group. Copies with single spaces.
 */
export default function Fingerprint({ value }) {
  const groups = spacedFingerprint(value).split(' ')
  const half = Math.ceil(groups.length / 2)
  return (
    <span className="fp">
      <span className="fp-half">{groups.slice(0, half).join(' ')}</span>{' '}
      <span className="fp-half">{groups.slice(half).join(' ')}</span>
    </span>
  )
}
