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
  actionMaxRepairAttempts: 2,
  actionTimeoutMs: 15_000,
  maxPayloadBytes: 128 * 1024,
  maxRuntimeAssetBytes: 1024 * 1024,
  maxNetworkResponseBytes: 2 * 1024 * 1024,
  codexBin: process.env.CODEX_BIN || 'codex',
};
