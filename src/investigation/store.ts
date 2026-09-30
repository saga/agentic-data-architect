import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { Claim } from '../evidence/types.js';

/**
 * Investigation 是 Agent 的工作状态（§二十八），不是 chat session。
 * V1：单个 JSON 文件即真相，落在 .data/investigations/<name>.json。
 */

export interface Investigation {
  name: string;
  goal: string;
  scope: string[];
  systems: string[];
  questions: string[];
  claims: Claim[];
  unknowns: string[];
  updatedAt: string;
}

export function newInvestigation(name: string): Investigation {
  return {
    name,
    goal: '',
    scope: [],
    systems: [],
    questions: [],
    claims: [],
    unknowns: [],
    updatedAt: new Date().toISOString(),
  };
}

function filePath(name: string): string {
  return path.join(config.investigationDir, `${name}.json`);
}

export async function saveInvestigation(inv: Investigation): Promise<string> {
  inv.updatedAt = new Date().toISOString();
  await fs.mkdir(config.investigationDir, { recursive: true });
  const fp = filePath(inv.name);
  await fs.writeFile(fp, JSON.stringify(inv, null, 2));
  return fp;
}

export async function loadInvestigation(name: string): Promise<Investigation> {
  const raw = await fs.readFile(filePath(name), 'utf-8');
  return JSON.parse(raw) as Investigation;
}

export async function investigationExists(name: string): Promise<boolean> {
  try {
    await fs.access(filePath(name));
    return true;
  } catch {
    return false;
  }
}
