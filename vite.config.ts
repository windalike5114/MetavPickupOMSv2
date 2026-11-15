import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { randomUUID } from 'node:crypto';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode, command}) => {
  const env = loadEnv(mode, '.', '');
  const buildId = command === 'build' ? randomUUID() : '';
  return {
    plugins: [
      react(), 
      tailwindcss(),
      {
        name: 'wms-client-build',
        apply: 'build',
        transformIndexHtml: {
          order: 'pre',
          handler: html => html.replace('WMS_BUILD_ID_PENDING', buildId),
        },
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'client-build.json', source: JSON.stringify({ id: buildId }) });
        },
      },
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
