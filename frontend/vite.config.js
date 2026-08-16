import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the built site works whether it's deployed at a
// domain root (Vercel) or under a repo subpath (GitHub Pages project
// site, e.g. username.github.io/repo-name/) without hardcoding the path.
export default defineConfig({
  plugins: [react()],
  base: './',
})
