/**
 * Selected pi-ai provider factories. Literal imports only; no providers/all
 * barrel and no ambient credential discovery. Callers receive a fresh SDK
 * Provider each time. Auth kind (api vs oauth) is applied by the caller.
 *
 * The pinned SDK hides OAuth implementations behind variable imports. Our
 * build resolves the four private flow imports below so cold installs contain
 * them. Replace lazy handlers explicitly; unsupported OAuth is not exposed.
 */

import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { openaiCodexOAuth } from "@earendil-works/pi-ai/auth/oauth/openai-codex";
import { githubCopilotOAuth } from "@earendil-works/pi-ai/auth/oauth/github-copilot";
import { xaiOAuth } from "@earendil-works/pi-ai/auth/oauth/xai";
import { kimiCodingOAuth } from "@earendil-works/pi-ai/auth/oauth/kimi-coding";

const OAUTH_FLOWS = Object.freeze({
  "openai-codex": openaiCodexOAuth,
  "github-copilot": githubCopilotOAuth,
  xai: xaiOAuth,
  "kimi-coding": kimiCodingOAuth
});

const FACTORIES = Object.freeze({
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  zai: zaiProvider,
  xai: xaiProvider,
  moonshotai: moonshotaiProvider,
  "kimi-coding": kimiCodingProvider,
  "openai-codex": openaiCodexProvider,
  "github-copilot": githubCopilotProvider
});

/**
 * @param {string} id
 * @returns {import("@earendil-works/pi-ai").Provider}
 */
export function createBuiltinProvider(id) {
  const factory = FACTORIES[id];
  if (typeof factory !== "function") {
    throw new Error(`unsupported provider ${id}`);
  }
  const provider = factory();
  return {
    ...provider,
    auth: {
      ...(provider.auth.apiKey ? { apiKey: provider.auth.apiKey } : {}),
      ...(OAUTH_FLOWS[id] ? { oauth: OAUTH_FLOWS[id] } : {})
    }
  };
}
