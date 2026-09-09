import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { randomUUID } from 'node:crypto'

const buildIdentity = { application: 'workstack', buildId: randomUUID() }

export default defineConfig({
  root: 'src/renderer',
  define: { 'import.meta.env.VITE_WORKSTACK_BROWSER_DEMO': JSON.stringify('true') },
  plugins: [react(), {
    name: 'workstack-build-identity',
    transformIndexHtml: (html) => html.replace('</head>', `<meta name="workstack-build-id" content="${buildIdentity.buildId}"></head>`),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'workstack-build.json', source: JSON.stringify(buildIdentity) })
    }
  }],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true
  }
})
