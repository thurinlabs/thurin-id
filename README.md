# thurin.id

Look up any Ethereum address, ENS name, or PGP fingerprint to view on-chain identity claims and verified proofs — and create your own claim at `/attest`.

A [Thurin Labs](https://thurinlabs.id) project. Live at **https://thurin.id**.

## What it does

thurin.id is the Thurin identity explorer. It reads from the `PGPRegistry` contract on Ethereum mainnet and verifies identity proofs linked to PGP keys, entirely client-side — there is no backend.

1. **Look up an identity** — enter an ETH address, ENS name, or PGP fingerprint
2. **View on-chain claims** — see which PGP keys are attested to which addresses
3. **Verify proofs** — `proof@thurin.id` notations in PGP keys are checked against GitHub, DNS, Farcaster, Codeberg, and Mastodon
4. **Attest** — bind your own Ethereum address and PGP key on-chain at [`/attest`](https://thurin.id/attest)

## Setup

`thurin-id` depends on [`@thurinlabs/identity-kit`](https://github.com/thurinlabs/identity-kit) via `file:../identity-kit`, so clone the two as siblings and build identity-kit first:

```bash
cd ../identity-kit && npm install && npm run build
cd ../thurin-id && npm install
npm run dev
```

Requires a `.env` file:

```
VITE_ALCHEMY_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
VITE_NEYNAR_API_KEY=YOUR_NEYNAR_KEY
```

`VITE_ALCHEMY_RPC_URL` is optional for reads (the v2 registry needs only `eth_call`, so the keyless public default works); it is still the RPC the wallet flow uses.

## Running against a local chain or Sepolia

The PGPRegistry v2 has the same address on every network (`0x9302E02e2869e129aC8516fE5eFFd51EA3082c09`). Set `VITE_CHAIN` and every chain-specific piece — wallet chain, RPC, explorer links — follows; the topbar shows a testnet badge.

**Local (fastest):** run `anvil`, deploy the registry from the `pgp-registry` repo (`forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key <anvil key> --broadcast`), import an anvil test account into your wallet and add a network for `http://127.0.0.1:8545` (chain id 31337), then:

```bash
VITE_CHAIN=local npm run dev
```

**Sepolia:** `VITE_CHAIN=sepolia npm run dev`. Your Alchemy key serves Sepolia from the same app (`eth-sepolia` host, swapped automatically). Get test ETH from a Sepolia faucet.

Production builds leave `VITE_CHAIN` unset, so they stay on mainnet.

## How it works

The explorer reads attestations straight from the `PGPRegistry` contract — history, stored signature, and stored key, all plain `eth_call`s that any RPC serves — and parses the `proof@thurin.id` notations on the on-chain key. No keyserver is consulted. Verification lives in identity-kit and runs in the browser:

- **GitHub** — fetches the gist via GitHub API, checks ownership and for `openpgp4fpr:FINGERPRINT`
- **DNS** — queries TXT records via Cloudflare DNS-over-HTTPS, checks for `openpgp4fpr:FINGERPRINT`
- **Farcaster** — resolves the user's FID, scans recent casts via Neynar, checks for `openpgp4fpr:FINGERPRINT`
- **Codeberg** — checks the repository description
- **Mastodon** — checks profile metadata

## Routes

| Path | What |
|------|------|
| `/` | Explorer |
| `/eth/<address>`, `/ens/<name>`, `/pgp/<fingerprint>` | Identity pages |
| `/attest` | Create an on-chain identity claim |

`/signet` (the old attestation route) is a 301 to `/attest`, served by nginx.

## IPFS

The build output (`npm run build`) is a static `dist/` folder with relative asset paths — pin it to IPFS directly.
