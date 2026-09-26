import { useQuery } from '@tanstack/react-query'
import { NETWORK } from './wagmiConfig'

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || ''

/** The relay's URL, only once it has said it publishes to this site's network; null otherwise. */
export function useRelay() {
  const { data } = useQuery({
    queryKey: ['relay', RELAYER_URL],
    queryFn: async () => (await (await fetch(RELAYER_URL)).json()).network ?? null,
    enabled: !!RELAYER_URL,
    staleTime: Infinity,
    retry: false,
  })
  return RELAYER_URL && data === NETWORK ? RELAYER_URL : null
}
