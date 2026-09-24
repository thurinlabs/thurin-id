import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'

// Content-Security-Policy as a <meta> tag, so it holds on every host that serves the build
// (thurin.id, IPFS gateways, eth.limo) without server headers. Added at build time only:
// the dev server injects its own inline scripts.
//
// What it buys: no injected script runs (only our bundle and the hashed inline theme script),
// no plugins, no <base> or form hijack, frames only for WalletConnect's verify page.
// What it can't: fence network access. Mastodon proofs fetch from any instance and the RPC
// is configurable, so connect-src stays https:. A tampered deploy would ship its own CSP;
// deploy integrity is the pinned deploy's job, not this.
function csp(mode) {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const local = env.VITE_CHAIN === 'local' ? ` ${new URL(env.VITE_LOCAL_RPC_URL || 'http://127.0.0.1:8545').origin}` : ''
  return {
    name: 'thurin-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
          .map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')}`,
          "style-src 'self' 'unsafe-inline'",   // RainbowKit writes its theme as an inline <style>
          "img-src 'self' data: blob: https:",   // wallet icons; avatars are filtered in src/avatar.js
          "font-src 'self' data:",
          `connect-src 'self' https: wss:${local}`,
          'frame-src https://verify.walletconnect.com https://verify.walletconnect.org',
          "worker-src 'self' blob:",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'none'",
        ].join('; ')
        return html.replace(/<meta charset="UTF-8" \/>/, m => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
      },
    },
  }
}

// deploy.sh passes the commit it built from; the live page then says which code it is
// (view source → thurin-commit), and deploys.log pairs that commit with the CID.
const commitMeta = {
  name: 'thurin-commit',
  apply: 'build',
  transformIndexHtml(html) {
    const c = process.env.THURIN_COMMIT
    return c && /^[0-9a-f]{40}(-dirty)?$/.test(c) ? html.replace('</head>', `  <meta name="thurin-commit" content="${c}" />\n  </head>`) : html
  },
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), csp(mode), commitMeta],
  base: './',
  define: {
    global: 'globalThis',
  },
}))
