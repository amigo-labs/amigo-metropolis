/// <reference types="vite/client" />

/**
 * Short git commit of the build, injected by vite.config.ts `define`.
 * Empty string when git was unavailable; undefined outside a vite build (the
 * bun unit tests import client modules directly), so read it through a
 * `typeof` guard.
 */
declare const __COMMIT__: string;
