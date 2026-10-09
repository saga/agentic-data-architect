/**
 * One provider/model catalog shared by the UI, session creation and Runtime selection.
 * Provider preference comes from Global config; availability comes from live discovery plus
 * durable actionable failure information. They are intentionally separate concepts.
 */
import { config } from '../config.js';
import type { AgentRuntime } from '../investigation/schemas.js';
import { loadGlobalConfiguration } from '../investigation/control.js';
import { getClient } from './copilot.js';
import { listCodeBuddyModels } from './codebuddy.js';
import { listOpenCodeModels } from './opencode.js';
import {
  clearProviderFailure,
  getProviderFailures,
  getProviderHealthRevision,
  recordProviderFailure,
} from './provider-health.js';

export type CatalogModel = {
  id: string;
  name: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  policyState: string | null;
  runtime: 'codebuddy' | 'copilot' | 'opencode';
};

export type ProviderState =
  | 'available'
  | 'configured'
  | 'unavailable'
  | 'quota_exhausted'
  | 'authentication_error'
  | 'connection_error'
  | 'disabled';

export interface AgentProviderStatus {
  runtime: AgentRuntime;
  label: string;
  state: ProviderState;
  usable: boolean;
  modelCount: number;
  message: string;
  checkedAt: string;
  lastFailureAt?: string;
  failedModel?: string;
}

export interface AgentCatalog {
  models: CatalogModel[];
  providers: AgentProviderStatus[];
  configuredDefaultRuntime: AgentRuntime;
  recommendedRuntime: AgentRuntime;
  fallbackOrder: AgentRuntime[];
}

interface DiscoveryResult {
  models: CatalogModel[];
  count: number;
  state: ProviderState;
  message: string;
}

const RUNTIMES: AgentRuntime[] = ['copilot-sdk', 'codebuddy-sdk', 'opencode-run'];
const LABELS: Record<AgentRuntime, string> = {
  'copilot-sdk': 'GitHub Copilot SDK',
  'codebuddy-sdk': 'CodeBuddy SDK',
  'opencode-run': 'OpenCode Run',
};

let cachedCatalog: { value: AgentCatalog; createdAt: number; healthRevision: number } | undefined;
let pendingCatalog: Promise<AgentCatalog> | undefined;

export function invalidateAgentCatalog(): void {
  cachedCatalog = undefined;
}

export function selectRecommendedRuntime(
  configuredDefault: AgentRuntime,
  fallbackOrder: readonly AgentRuntime[],
  providers: readonly Pick<AgentProviderStatus, 'runtime' | 'usable'>[],
): AgentRuntime {
  const usable = new Set(providers.filter((provider) => provider.usable).map((provider) => provider.runtime));
  if (usable.has(configuredDefault)) return configuredDefault;
  for (const runtime of [...fallbackOrder, ...RUNTIMES]) {
    if (usable.has(runtime)) return runtime;
  }
  // No provider is available: retain a stable value for the form, while the UI disables submission.
  return configuredDefault;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverProviders(): Promise<AgentCatalog> {
  const checkedAt = new Date().toISOString();
  const results = new Map<AgentRuntime, DiscoveryResult>();

  const copilot = (async () => {
    try {
      const models = await (await getClient()).listModels();
      const normalized = models.map((model) => ({
        id: model.id,
        name: model.name,
        supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
        defaultReasoningEffort: model.defaultReasoningEffort ?? null,
        policyState: model.policy?.state ?? null,
        runtime: 'copilot' as const,
      }));
      if (normalized.length > 0) {
        const previous = (await getProviderFailures())['copilot-sdk'];
        if (previous && previous.category !== 'quota_exhausted') await clearProviderFailure('copilot-sdk');
        results.set('copilot-sdk', {
          models: normalized,
          count: normalized.length,
          state: 'available',
          message: 'Copilot 已连接，发现 ' + normalized.length + ' 个模型。',
        });
      } else {
        results.set('copilot-sdk', {
          models: [],
          count: 0,
          state: 'unavailable',
          message: 'Copilot 没有返回可用模型。',
        });
      }
    } catch (error) {
      await recordProviderFailure('copilot-sdk', undefined, error).catch((persistError) => {
        console.error('[provider-catalog] Failed to record Copilot discovery failure.', persistError);
      });
      results.set('copilot-sdk', {
        models: [],
        count: 0,
        state: 'unavailable',
        message: formatError(error),
      });
      console.warn('[provider-catalog] Copilot discovery failed.', { error });
    }
  })();

  const codeBuddy = (async () => {
    try {
      const source = listCodeBuddyModels(config.codeBuddyModelAllowlist);
      const models = source.map((model) => ({
        id: model.id,
        name: model.name,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        policyState: null,
        runtime: 'codebuddy' as const,
      }));
      results.set('codebuddy-sdk', {
        models,
        count: models.length,
        state: models.length > 0 ? 'configured' : 'unavailable',
        message: models.length > 0
          ? 'CodeBuddy 已配置 ' + models.length + ' 个模型候选；认证和配额会在首次调用时验证。'
          : 'CODEBUDDY_MODEL_ALLOWLIST 为空，没有可选模型。',
      });
    } catch (error) {
      results.set('codebuddy-sdk', {
        models: [],
        count: 0,
        state: 'unavailable',
        message: formatError(error),
      });
      console.warn('[provider-catalog] CodeBuddy model discovery failed.', { error });
    }
  })();

  const openCode = (async () => {
    if (!config.openCodeEnabled) {
      results.set('opencode-run', {
        models: [],
        count: 0,
        state: 'disabled',
        message: 'OpenCode 已通过 OPENCODE_ENABLED=false 禁用。',
      });
      return;
    }
    try {
      const source = await listOpenCodeModels();
      const models = source.map((model) => ({
        id: model.id,
        name: model.name,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        policyState: null,
        runtime: 'opencode' as const,
      }));
      const previous = (await getProviderFailures())['opencode-run'];
      if (models.length > 0 && previous && previous.category !== 'quota_exhausted') {
        await clearProviderFailure('opencode-run');
      }
      results.set('opencode-run', {
        models,
        count: models.length,
        state: models.length > 0 ? 'available' : 'unavailable',
        message: models.length > 0
          ? 'OpenCode 已连接，发现 ' + models.length + ' 个模型。'
          : 'OpenCode 可连接，但没有发现已连接的模型。',
      });
    } catch (error) {
      await recordProviderFailure('opencode-run', undefined, error).catch((persistError) => {
        console.error('[provider-catalog] Failed to record OpenCode discovery failure.', persistError);
      });
      results.set('opencode-run', {
        models: [],
        count: 0,
        state: 'unavailable',
        message: formatError(error),
      });
      console.warn('[provider-catalog] OpenCode discovery failed.', { error });
    }
  })();

  await Promise.all([copilot, codeBuddy, openCode]);
  const failures = await getProviderFailures();
  const providers = RUNTIMES.map((runtime): AgentProviderStatus => {
    const result = results.get(runtime)!;
    const failure = failures[runtime];
    if (failure) {
      return {
        runtime,
        label: LABELS[runtime],
        state: failure.category,
        usable: false,
        modelCount: result.count,
        message: failure.message,
        checkedAt,
        lastFailureAt: failure.failedAt,
        ...(failure.model ? { failedModel: failure.model } : {}),
      };
    }
    const usable = result.state === 'available' || result.state === 'configured';
    return {
      runtime,
      label: LABELS[runtime],
      state: result.state,
      usable,
      modelCount: result.count,
      message: result.message,
      checkedAt,
    };
  });

  let configuredDefaultRuntime: AgentRuntime = config.agentRuntimeDefault;
  try {
    configuredDefaultRuntime = (await loadGlobalConfiguration()).agent.runtime;
  } catch (error) {
    console.warn('[provider-catalog] Could not read Global runtime preference; using environment default.', {
      error,
      fallback: config.agentRuntimeDefault,
    });
  }

  const fallbackOrder = [...new Set([
    ...config.agentRuntimeFallbackOrder.filter((value): value is AgentRuntime =>
      RUNTIMES.includes(value as AgentRuntime),
    ),
    configuredDefaultRuntime,
    ...RUNTIMES,
  ])];
  // Copilot is the primary runtime for this workbench. Prefer it when live discovery
  // confirms it is usable; retain explicit configured preference only when Copilot is unavailable.
  const recommendedRuntime = providers.some((provider) => provider.runtime === 'copilot-sdk' && provider.usable)
    ? 'copilot-sdk'
    : selectRecommendedRuntime(configuredDefaultRuntime, fallbackOrder, providers);
  const models = providers
    .filter((provider) => provider.usable && provider.runtime !== 'opencode-run')
    .flatMap((provider) => results.get(provider.runtime)!.models);

  return {
    models,
    providers,
    configuredDefaultRuntime,
    recommendedRuntime,
    fallbackOrder,
  };
}

export async function getAgentCatalog(options: { force?: boolean } = {}): Promise<AgentCatalog> {
  const now = Date.now();
  const healthRevision = getProviderHealthRevision();
  if (
    !options.force
    && cachedCatalog
    && now - cachedCatalog.createdAt < 5_000
    && cachedCatalog.healthRevision === healthRevision
  ) {
    return cachedCatalog.value;
  }
  if (!options.force && pendingCatalog) return pendingCatalog;

  const pending = discoverProviders();
  pendingCatalog = pending;
  try {
    const value = await pending;
    cachedCatalog = {
      value,
      createdAt: Date.now(),
      healthRevision: getProviderHealthRevision(),
    };
    return value;
  } finally {
    if (pendingCatalog === pending) pendingCatalog = undefined;
  }
}
