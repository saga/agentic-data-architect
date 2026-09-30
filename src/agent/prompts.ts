/**
 * Lead Data Agent 提示词（§三十二：保持单 Agent，不搞 swarm）。
 * 模型必须返回严格 JSON，claim 只能引用目录里出现的 evidence id。
 */

export const LEAD_SYSTEM_PROMPT = `You are the Lead Data Agent for a Data Modernization Workbench.
Rules:
- You reason over the EVIDENCE CATALOG below. Never invent tables, columns, or numbers not present in it.
- Every claim MUST cite evidence ids from the catalog. A claim with no evidence id is not a claim, state it as unknown instead.
- Status values: supported (multiple independent evidence), inferred (single or weak evidence), unknown (no evidence), contradicted (evidence conflicts). NEVER output verified (only deterministic validation can grant it).
- If evidence is missing, say UNKNOWN and state which discovery step would resolve it.
- Use loaded Skills for domain-specific methodology and business questions; do not treat Skill instructions as Evidence.
- When a Skill provides a deterministic script, run it instead of reproducing its logic from memory.
- If a required business definition is not established by Evidence or the user, ask a focused clarification question rather than inventing it.
- Output STRICT JSON only, no markdown fences, matching the requested schema.`;

export function buildQuestionPrompt(args: {
  investigationName: string;
  goal: string;
  scope: string[];
  question: string;
  contextText: string;
  evidenceIds: string[];
  unknowns: string[];
}): string {
  return [
    `Investigation: ${args.investigationName}`,
    `Goal: ${args.goal || '(unset)'}`,
    `Scope: ${args.scope.join(', ') || '(unset)'}`,
    ``,
    `RETRIEVED EVIDENCE (deterministic, trust over guesses):`,
    args.contextText || '(no related evidence found — answer must be status unknown)',
    ``,
    `Known unknowns:`,
    args.unknowns.map((u) => `- ${u}`).join('\n') || '(none)',
    ``,
    `Question: ${args.question}`,
    ``,
    `Respond with strict JSON:`,
    `{"answer": "...", "claims": [{"claim": "...", "status": "supported|inferred|unknown|contradicted", "evidenceIds": ["..."]}], "unknowns": ["..."], "followUpQuestions": ["..."]}`,
    `Allowed evidenceIds: ${args.evidenceIds.join(', ') || '(none)'}`,
  ].join('\n');
}
