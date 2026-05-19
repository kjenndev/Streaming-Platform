import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import 'primereact/resources/themes/lara-dark-indigo/theme.css' // dark theme base
import 'primereact/resources/primereact.min.css'                  // core css
import 'primeicons/primeicons.css'                                // icons
import 'primeflex/primeflex.css'                                  // flex
import './index.css'
import { PrimeReactProvider } from 'primereact/api';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrimeReactProvider>
      <App />
    </PrimeReactProvider>
  </React.StrictMode>,
)
