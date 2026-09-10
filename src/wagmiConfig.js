import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { mainnet } from 'wagmi/chains'

export const RPC_URL = import.meta.env.VITE_ALCHEMY_RPC_URL

export const config = getDefaultConfig({
  appName: 'Thurin',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  chains: [mainnet],
  transports: {
    [mainnet.id]: http(RPC_URL),
  },
  ssr: false,
})

export const REGISTRY_ADDRESS = '0xf7a45BC662A78a6fb417ED5f52b3766cbf13EbBb'

// ABI: events + reads (used by explorer) + writes (used by the attestation flow at /attest)
export const REGISTRY_ABI = [
  {
    name: 'Attested',
    type: 'event',
    inputs: [
      { name: 'ethAddress', type: 'address', indexed: true },
      { name: 'fingerprintHash', type: 'string', indexed: true },
      { name: 'fingerprint', type: 'string', indexed: false },
      { name: 'pgpSignature', type: 'string', indexed: false },
      { name: 'pgpPublicKey', type: 'string', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
      { name: 'timestamp', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'attest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'fingerprint', type: 'string' },
      { name: 'pgpSignature', type: 'string' },
      { name: 'pgpPublicKey', type: 'string' },
    ],
    outputs: [],
  },
  {
    name: 'revoke',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'attestationCount',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'getAttestation',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'addr', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [
      { name: 'fingerprint', type: 'string' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'revoked', type: 'bool' },
    ],
  },
]
