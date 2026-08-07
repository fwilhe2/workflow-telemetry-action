// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import nodeResolve from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'

// Unlike the upstream template, this action ships three separate bundles:
//   main / post - the action's entry points, referenced from action.yml
//   scw         - spawned as its own process by the stat collector, so it
//                 cannot share a chunk with the entry points.
const bundles = {
  main: 'src/main.ts',
  post: 'src/post.ts',
  scw: 'src/statCollectorWorker.ts'
}

const config = Object.entries(bundles).map(([name, input]) => ({
  input,
  output: {
    esModule: true,
    file: `dist/${name}/index.js`,
    format: 'es',
    sourcemap: true,
    // Each bundle has to be a single self-contained file.
    inlineDynamicImports: true
  },
  plugins: [
    typescript(),
    nodeResolve({ preferBuiltins: true }),
    commonjs(),
    json()
  ]
}))

export default config
