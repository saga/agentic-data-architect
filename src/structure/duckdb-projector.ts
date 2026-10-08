import fs from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { CodeStructureIndex } from './types.js';

export const DEFAULT_STRUCTURE_DATABASE = '.code-structure/structure.duckdb';

export class CodeStructureDuckDBProjector {
  constructor(
    private readonly rootDirectory: string,
    private readonly databaseFile = path.join(rootDirectory, DEFAULT_STRUCTURE_DATABASE),
  ) {}

  async project(index: CodeStructureIndex): Promise<string> {
    const database = path.resolve(this.databaseFile);
    await fs.mkdir(path.dirname(database), { recursive: true });
    const instance = await DuckDBInstance.create(database);
    const connection = await instance.connect();
    try {
      await connection.run('BEGIN');
      await connection.run('DROP TABLE IF EXISTS structure_edges');
      await connection.run('DROP TABLE IF EXISTS structure_nodes');
      await connection.run('DROP TABLE IF EXISTS structure_files');
      await connection.run('DROP TABLE IF EXISTS structure_metadata');
      await connection.run('CREATE TABLE structure_metadata (key VARCHAR NOT NULL, value VARCHAR NOT NULL)');
      await connection.run('CREATE TABLE structure_files (path VARCHAR NOT NULL, hash VARCHAR NOT NULL, parser VARCHAR NOT NULL)');
      await connection.run('CREATE TABLE structure_nodes (id VARCHAR NOT NULL, kind VARCHAR NOT NULL, name VARCHAR NOT NULL, file VARCHAR NOT NULL, line INTEGER)');
      await connection.run('CREATE TABLE structure_edges (from_id VARCHAR NOT NULL, to_id VARCHAR NOT NULL, kind VARCHAR NOT NULL, confidence VARCHAR NOT NULL, file VARCHAR, line INTEGER)');

      const metadata = await connection.createAppender('structure_metadata');
      for (const [key, value] of [['schema_version', '1'], ['root', index.root], ['generated_at', index.generatedAt]]) {
        metadata.appendVarchar(key); metadata.appendVarchar(value); metadata.endRow();
      }
      metadata.flushSync(); metadata.closeSync();

      const files = await connection.createAppender('structure_files');
      for (const file of index.files) {
        files.appendVarchar(file.path); files.appendVarchar(file.hash); files.appendVarchar(file.parser); files.endRow();
      }
      files.flushSync(); files.closeSync();

      const nodes = await connection.createAppender('structure_nodes');
      for (const node of index.nodes) {
        nodes.appendVarchar(node.id); nodes.appendVarchar(node.kind); nodes.appendVarchar(node.name); nodes.appendVarchar(node.file);
        if (node.line === undefined) nodes.appendNull(); else nodes.appendInteger(node.line);
        nodes.endRow();
      }
      nodes.flushSync(); nodes.closeSync();

      const edges = await connection.createAppender('structure_edges');
      for (const edge of index.edges) {
        edges.appendVarchar(edge.from); edges.appendVarchar(edge.to); edges.appendVarchar(edge.kind); edges.appendVarchar(edge.confidence);
        if (edge.file === undefined) edges.appendNull(); else edges.appendVarchar(edge.file);
        if (edge.line === undefined) edges.appendNull(); else edges.appendInteger(edge.line);
        edges.endRow();
      }
      edges.flushSync(); edges.closeSync();
      await connection.run('COMMIT');
      return database;
    } catch (error) {
      try { await connection.run('ROLLBACK'); } catch {}
      throw error;
    } finally {
      connection.disconnectSync();
    }
  }
}
