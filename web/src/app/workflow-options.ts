import type { WorkflowId } from './types';

export const workflowOptions: ReadonlyArray<{ value: WorkflowId | ''; label: string }> = [
  { value: '', label: '自主调查' },
  { value: 'legacy-modernization', label: '改造已有系统' },
  { value: 'financial-ai-native-architecture', label: '金融 AI / 数据架构设计' },
  { value: 'data-architecture-assessment', label: '数据架构评估' },
];

export function workflowLabel(workflow: WorkflowId | null | undefined): string {
  switch (workflow) {
    case 'legacy-modernization': return '改造已有系统';
    case 'financial-ai-native-architecture': return '金融 AI / 数据架构设计';
    case 'data-architecture-assessment': return '数据架构评估';
    default: return '自主调查';
  }
}
