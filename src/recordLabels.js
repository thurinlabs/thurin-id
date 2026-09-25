// What the page calls each Thurin record kind. Other names show as they are.
export const KIND_LABEL = {
  'thurin.railgun': 'Pay privately',
  'thurin.security': 'Security contact',
  'thurin.successor': 'Successor key',
  'thurin.affiliation': 'Affiliation',
  'thurin.canary': 'Canary',
  'thurin.private': 'Private',
  'thurin.disclosure': 'Disclosure',
}

export const kindLabel = (kind) => KIND_LABEL[kind] || kind
