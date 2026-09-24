import React from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { config, CHAIN } from './wagmiConfig'
import App from './App'
// Fonts ship with the site: no request to Google on every page view (privacy), and the
// IPFS copy renders without a third party. Latin subsets, only the weights the CSS uses.
import '@fontsource/cinzel/latin-400.css'
import '@fontsource/cinzel/latin-500.css'
import '@fontsource/cinzel/latin-600.css'
import '@fontsource/cinzel/latin-700.css'
import '@fontsource/crimson-pro/latin-300.css'
import '@fontsource/crimson-pro/latin-400.css'
import '@fontsource/crimson-pro/latin-400-italic.css'
import '@fontsource/crimson-pro/latin-500.css'
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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={CHAIN}
          theme={darkTheme({
            accentColor: '#c9a227',
            accentColorForeground: '#141010',
            borderRadius: 'medium',
          })}
        >
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
)
