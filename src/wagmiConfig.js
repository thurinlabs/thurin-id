import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { safeWallet, rainbowWallet, base, metaMaskWallet, ledgerWallet, trustWallet, zerionWallet } from '@rainbow-me/rainbowkit/wallets'
import { http } from 'wagmi'
import { mainnet, sepolia, foundry } from 'wagmi/chains'
import { getRegistry, isNetworkName, REGISTRY_ABI } from '@thurinlabs/identity-kit'

// ─── Network ────────────────────────────────────────────────────────────────
// VITE_CHAIN=mainnet (default) | sepolia | local (anvil). Everything chain-specific
// derives from this: the wagmi chain, the registry address, the RPC, and the
// explorer links. Production builds leave it unset.
export const NETWORK = isNetworkName(import.meta.env.VITE_CHAIN) ? import.meta.env.VITE_CHAIN : 'mainnet'
export const CHAIN = NETWORK === 'sepolia' ? sepolia : NETWORK === 'local' ? foundry : mainnet
// The v2 registry has the same address on every network; VITE_REGISTRY_ADDRESS overrides it
// (e.g. a local deploy that landed elsewhere).
export const REGISTRY = getRegistry(NETWORK, import.meta.env.VITE_REGISTRY_ADDRESS)
export const REGISTRY_ADDRESS = REGISTRY.address
export const EXPLORER_URL = REGISTRY.explorerUrl // '' on local: no explorer links
export { REGISTRY_ABI }

// Alchemy serves every network from the same app key; swap the host for Sepolia
// unless a dedicated URL is given. Local talks to anvil directly.
const MAINNET_RPC = import.meta.env.VITE_ALCHEMY_RPC_URL
export const RPC_URL = NETWORK === 'local'
  ? (import.meta.env.VITE_LOCAL_RPC_URL || REGISTRY.defaultRpcUrl)
  : NETWORK === 'sepolia'
    ? (import.meta.env.VITE_SEPOLIA_RPC_URL || (MAINNET_RPC || '').replace('eth-mainnet', 'eth-sepolia') || REGISTRY.defaultRpcUrl)
    : (MAINNET_RPC || REGISTRY.defaultRpcUrl)

// One chain per build. Offering a second one (tried for phone wallets without testnets)
// let the app sit on the wrong network without complaint; with a single chain RainbowKit
// shows "Wrong network" and offers the switch, and every write is pinned to CHAIN.id.
//
// The wallet list is RainbowKit's default minus `walletConnectWallet`. That one entry runs
// WalletConnect's own modal (Reown AppKit), which starts at page load and posts an analytics
// event with the full page URL (i.e. which identity is being viewed) to pulse.walletconnect.org,
// with no switch to turn it off. Every wallet below uses RainbowKit's own QR code instead;
// browser-extension wallets still show up on their own (EIP-6963).
export const config = getDefaultConfig({
  appName: 'Thurin',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  wallets: [
    { groupName: 'Popular', wallets: [safeWallet, rainbowWallet, base, metaMaskWallet] },
    { groupName: 'More', wallets: [ledgerWallet, trustWallet, zerionWallet] },
  ],
  chains: [CHAIN],
  transports: {
    [CHAIN.id]: http(RPC_URL),
  },
  ssr: false,
})
