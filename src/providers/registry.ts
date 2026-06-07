import type { Provider, ProviderId } from "./types.ts";
import { claudeProvider } from "./claude/index.ts";
import { codexProvider } from "./codex/index.ts";

const REGISTRY: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
};

export function getProvider(id: ProviderId): Provider {
  return REGISTRY[id];
}

export function allProviders(): Provider[] {
  return Object.values(REGISTRY);
}
