import type { ModernizationPlan } from '../model/modernization.js';

export function targetArchitectureComponentCount(
  targetArchitecture: ModernizationPlan['targetArchitecture'] | undefined,
): number {
  if (!targetArchitecture || targetArchitecture.status === 'draft') return 0;
  return targetArchitecture.components.length;
}

export function reviewedMappingCount(
  mappings: ModernizationPlan['mappings'] | undefined,
): number {
  return mappings?.filter((mapping) => ['reviewed', 'approved'].includes(mapping.status)).length ?? 0;
}

export function blockingValidationPassedCount(
  checks: ModernizationPlan['validationPlan']['checks'] | undefined,
): number {
  return checks?.filter((check) => check.blocking && check.status === 'passed').length ?? 0;
}

export function blockingValidationCount(
  checks: ModernizationPlan['validationPlan']['checks'] | undefined,
): number {
  return checks?.filter((check) => check.blocking).length ?? 0;
}
