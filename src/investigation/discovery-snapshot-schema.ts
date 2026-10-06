import * as z from 'zod';
import { DiscoveryRunSchema, EvidenceRefSchema } from '../evidence/types.js';
import { SemanticAssetListSchema } from '../semantic/types.js';

const SourceFileSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['sql', 'python', 'doc', 'yaml', 'json', 'other']),
  sizeBytes: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  modifiedAt: z.string().min(1),
  sha256: z.string().min(1),
}).strict();

export const InventorySchema = z.object({
  root: z.string().min(1),
  discoveryRunId: z.string().min(1),
  scannedAt: z.string().datetime(),
  files: z.array(SourceFileSchema),
  sqlFiles: z.array(z.string()),
  unknowns: z.array(z.string()),
}).strict();

export const LineageSnapshotSchema = z.object({
  edges: z.array(z.object({
    source: z.string().min(1),
    target: z.string().min(1),
    viaFile: z.string().min(1),
    evidenceId: z.string().min(1),
  }).strict()),
  tables: z.array(z.string()),
  columns: z.array(z.unknown()),
  statements: z.array(z.unknown()),
  parseFailures: z.array(z.object({
    file: z.string().min(1),
    statementIndex: z.number().int().nonnegative(),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    error: z.string().min(1),
  }).strict()),
  evidence: z.array(EvidenceRefSchema),
}).strict();

const CurrentStateCoverageSchema = z.object({
  filesScanned: z.number().int().nonnegative(),
  sqlFiles: z.number().int().nonnegative(),
  sqlParsedStatements: z.number().int().nonnegative(),
  sqlParseFailures: z.number().int().nonnegative(),
  datasets: z.number().int().nonnegative(),
  connectedDatasets: z.number().int().nonnegative(),
  datasetLineageConnectionRate: z.number().min(0).max(1).nullable(),
  columnLineageEdges: z.number().int().nonnegative(),
  semanticAssets: z.number().int().nonnegative(),
  profiledDatasets: z.number().int().nonnegative(),
}).strict();

const CurrentStateIntelligenceSchema = z.object({
  generatedAt: z.string().datetime(),
  coverage: CurrentStateCoverageSchema,
  sourceOfTruthCandidates: z.array(z.object({
    key: z.string(),
    candidateDatasetIds: z.array(z.string()),
    candidateDatasets: z.array(z.string()),
    priorityScore: z.number(),
    reasons: z.array(z.string()),
    evidenceIds: z.array(z.string()),
  }).strict()),
  semanticCandidates: z.array(z.object({
    key: z.string(),
    kind: z.enum(['business_concept', 'entity', 'identifier', 'metric', 'temporal_dimension']),
    names: z.array(z.string()),
    physicalAssets: z.array(z.string()),
    semanticAssets: z.array(z.string()),
    evidenceIds: z.array(z.string()),
  }).strict()),
  semanticAssets: SemanticAssetListSchema,
  highValueAssets: z.array(z.string()),
}).strict();

const DataEstateSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['system','application','interface','database','schema','data_store','dataset','column','file','api','message_topic','job','job_run','report','dashboard','business_concept']),
    name: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()),
  }).strict()),
  edges: z.array(z.object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    type: z.enum(['contains','reads_from','writes_to','derived_from','transformed_by','consumed_by','implements','mapped_to','defined_by']),
    evidenceIds: z.array(z.string()),
    relationMode: z.enum(['static','runtime','semantic']).optional(),
    expression: z.string().optional(),
  }).strict()),
}).strict();

export const DiscoverySnapshotSchema = z.object({
  run: DiscoveryRunSchema,
  inventory: InventorySchema.nullable(),
  lineage: LineageSnapshotSchema.nullable(),
  estate: DataEstateSchema,
  profiles: z.array(z.unknown()),
  semanticAssets: SemanticAssetListSchema,
  currentState: CurrentStateIntelligenceSchema,
  findingIds: z.array(z.string()),
}).strict();
