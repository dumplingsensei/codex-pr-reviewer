#!/usr/bin/env node
/**
 * Cold-install acceptance. Exercises bundled dist executables and an isolated
 * local marketplace/cache install — not unbundled source imports.
 *
 *   node --test tests/cross-model-advisor/installed.test.mjs
 */

import test from "node:test";
import {
  runColdBundleSmoke,
  runMarketplaceInstallSmoke
} from "./fixtures/installed-smoke.mjs";

test("isolated marketplace install does not npm-bootstrap and ships a license", async () => {
  await runMarketplaceInstallSmoke();
});

test("cold plugin copy doctor IPC loopback and late advice after Stop", async () => {
  await runColdBundleSmoke();
});
