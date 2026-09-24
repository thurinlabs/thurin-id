// ENS avatars without the tracking pixel. The rule (what may load) lives in the kit's
// core/avatar.ts, shared with ThurinCard and the embed; this is only the app-side hook, since
// the kit's own React hooks can't run here (the sibling link makes a second copy of wagmi).
import { createElement, useEffect, useState } from 'react'
import { useEnsText, useReadContract } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { normalize } from 'viem/ens'
import { avatarUrl, avatarFallbacks, parseNftAvatar, nftAvatarImage, NFT_AVATAR_ABI } from '@thurinlabs/identity-kit'
import { CHAIN } from './wagmiConfig'

function safeNormalize(name) { try { return normalize(name) } catch { return undefined } }

/** The avatar image URL to show for an ENS name, or undefined. */
export function useSafeAvatar(name) {
  const normalized = name ? safeNormalize(name) : undefined
  const { data: raw } = useEnsText({ name: normalized, key: 'avatar', chainId: CHAIN.id, query: { enabled: !!normalized } })
  const direct = avatarUrl(raw)
  const nft = direct ? null : parseNftAvatar(raw)
  const onChain = nft && nft.chainId === CHAIN.id
  const { data: tokenUri } = useReadContract({
    address: nft?.contract,
    abi: NFT_AVATAR_ABI,
    functionName: nft?.standard === 'erc1155' ? 'uri' : 'tokenURI',
    args: nft ? [nft.tokenId] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!onChain },
  })
  const { data: image } = useQuery({
    queryKey: ['nft-avatar', tokenUri, nft?.tokenId?.toString()],
    queryFn: () => nftAvatarImage(tokenUri, nft.tokenId).catch(() => null),
    enabled: typeof tokenUri === 'string' && !!nft,
  })
  return direct || image || undefined
}

/** An avatar <img> that retries through the other IPFS gateways if one fails, then renders `fallback`. */
export function AvatarImg({ src, className, fallback = null }) {
  const [tries, setTries] = useState([])
  useEffect(() => { setTries(src ? [src, ...avatarFallbacks(src)] : []) }, [src])
  if (!tries.length) return fallback
  return createElement('img', { src: tries[0], alt: '', className, onError: () => setTries((t) => t.slice(1)) })
}
