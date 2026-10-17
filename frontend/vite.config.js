import process from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Backend for the dev proxy; override with RUDRA_API=http://localhost:8010 when :8000 is taken.
const API_TARGET = process.env.RUDRA_API || 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api/copilot/stream': {
        target: API_TARGET,
        changeOrigin: true,
        // Disable proxy-level buffering so SSE tokens reach the browser immediately
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        },
      },
      '/api/agent/investigate': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        },
      },
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
