import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = process.cwd();
// Mutable app state can be pointed elsewhere so a test run never hydrates — and
// then fails — the builds a running Workshop server owns.
const dataDir = process.env.WORKSHOP_DATA_DIR ? path.resolve(rootDir, process.env.WORKSHOP_DATA_DIR) : rootDir;

export const config = {
  rootDir,
  dataDir,
  port: Number.parseInt(process.env.PORT || '4000', 10),
  model: process.env.OPENAI_MODEL || 'gpt-5.2-codex',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  apiToken: process.env.API_TOKEN || '',
  specsDir: path.join(dataDir, 'specs'),
  actionsDir: path.join(dataDir, 'actions'),
  appsDir: path.join(dataDir, 'apps'),
  workshopDir: path.join(dataDir, '.workshop'),
  publicDir: path.join(rootDir, 'public'),
  // The app-facing model primitive: fast and cheap, because apps call it inline
  // during an interaction rather than as a background job.
  llmModel: process.env.WORKSHOP_LLM_MODEL || 'gpt-5.6-luna',
  llmEffort: process.env.WORKSHOP_LLM_EFFORT || 'low',
  llmTimeoutMs: 45_000,
  llmMaxCallsPerAction: 8,
  // A conversational turn may look at several apps before it answers.
  desktopMaxSteps: 6,
  mcpTimeoutMs: 20_000,
  // First contact may download the server package; a tool call must not wait that long.
  mcpStartTimeoutMs: 90_000,
  mcpMaxCallsPerAction: 12,
  actionMemoryMb: 256,
  actionMaxRepairAttempts: 2,
  // Long enough for an action to make a model call with web search and still
  // return; ctx.llm bounds its own call below this, and safeFetch bounds its own.
  actionTimeoutMs: 60_000,
  maxPayloadBytes: 128 * 1024,
  maxRuntimeAssetBytes: 1024 * 1024,
  maxNetworkResponseBytes: 2 * 1024 * 1024,
  codexBin: process.env.CODEX_BIN || 'codex',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
};
