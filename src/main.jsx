import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config, CHAIN } from './wagmiConfig'
import App from './App'
// Fonts ship with the site: no request to Google on every page view (privacy), and the
// IPFS copy renders without a third party. Latin subsets, only the weights the CSS uses.
import '@fontsource/cinzel/latin-400.css'
import '@fontsource/cinzel/latin-600.css'
import '@fontsource/cinzel/latin-700.css'
import '@fontsource/crimson-pro/latin-400.css'
import '@fontsource/crimson-pro/latin-400-italic.css'
import '@fontsource/crimson-pro/latin-600.css'
import '@fontsource/share-tech-mono/latin-400.css'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'
import './attest.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
})

// The wallet UI follows the site's mode (the <html data-theme> the toggle sets), switching live.
const WALLET_THEMES = {
  dark: darkTheme({ accentColor: '#c9a227', accentColorForeground: '#141010', borderRadius: 'medium' }),
  light: lightTheme({ accentColor: '#5a7228', accentColorForeground: '#faf9f5', borderRadius: 'medium' }),
}
const siteMode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

function WalletKit({ children }) {
  const [mode, setMode] = useState(siteMode)
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(siteMode()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return <RainbowKitProvider initialChain={CHAIN} theme={WALLET_THEMES[mode]}>{children}</RainbowKitProvider>
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <WalletKit>
          <App />
        </WalletKit>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
)
