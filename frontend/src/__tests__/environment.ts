import { builtinEnvironments } from 'vitest/environments'
import type { Environment } from 'vitest/environments'

/**
 * jsdom ships its own `AbortController`/`AbortSignal`, and vitest 3 copies the
 * jsdom pair over the Node globals (`populateGlobal` in
 * `vitest/dist/chunks/index.*.js`). Node 24's `fetch` — the undici 7 the tests
 * run against — refuses a signal it did not create, so any request that carries
 * one throws `RequestInit: Expected signal (...) to be an instance of
 * AbortSignal` inside the jsdom environment. vitest 4 stopped copying the pair
 * over the globals (vitest-dev/vitest#8390); until this suite moves to vitest 4,
 * restore the Node pair once jsdom's `setup` has claimed them, so `fetch(...,
 * { signal })` behaves in a test the way it does in a browser.
 */
const nodeGlobals = {
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
}

const jsdom = builtinEnvironments.jsdom

export default {
  name: 'jsdom-node-abort',
  transformMode: jsdom.transformMode,
  async setup(global, options) {
    const environment = await jsdom.setup(global, options)
    Object.assign(global, nodeGlobals)
    return environment
  },
} satisfies Environment
