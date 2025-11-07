import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',        // O true. Nunca pongas el dominio de ngrok aquí.
    port: 5175,
    allowedHosts: [/\.ngrok-free\.dev$/],
    hmr: {
      host: 'appellate-naively-temperance.ngrok-free.dev', // tu subdominio
      clientPort: 443,            // puerto que usa el navegador hacia ngrok
      protocol: 'wss'             // por túnel HTTPS
      // NO pongas "port: 443" aquí, forzaría a Vite a escuchar en 443.
    }
  }
})
