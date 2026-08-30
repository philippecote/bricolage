export type AppStatus = 'draft' | 'building' | 'ready' | 'failed' | 'archived';
export interface WorkshopApp {
  id: string; name: string; description: string; icon: string; accent: string; status: AppStatus;
  prompt: string; pinned: boolean; archived: boolean; createdAt: string; updatedAt: string;
  window: { width: number; height: number }; actions: string[]; connections?: string[]; threadId: string | null; revision: number; model: ModelPreset; error: string | null;
}
export type ModelPreset = 'luna-high' | 'luna-max' | 'sol-medium' | 'opus-5-high';
export interface BuildQuestion { id: string; prompt: string; options: string[] }
export interface BuildEvent { id: string; buildId: string; appId: string; phase: string; message: string; at: string; questions?: BuildQuestion[]; plan?: string[]; approval?: { id: string; summary: string }; preview?: boolean }
export interface BuildSummary { id: string; appId: string; status: string; model: ModelPreset; createdAt: string; updatedAt: string; events: BuildEvent[]; questions?: BuildQuestion[]; plan?: string[] }
export interface ConnectionSecret { key: string; from: string; missing: boolean }
export interface Connection { id: string; label: string; enabled: boolean; command: string; connected: boolean; tools: string[]; secrets?: ConnectionSecret[]; error: string | null }
export interface AgentState { available: boolean; authenticated: boolean; accountType?: string | null; error: string | null }
export interface SystemStatus { name: string; version: string; codex: AgentState; agents?: { codex: AgentState; claude: AgentState }; connections?: Connection[]; activeBuilds: BuildSummary[] }

export interface PendingAct { callId: string; tool: string; args: Record<string, string> }
export interface DesktopReply {
  conversationId: string;
  reply: string;
  performed: Array<{ tool: string; args: Record<string, string> }>;
  pending: PendingAct | null;
  effect?: { type: string; appId?: string; buildId?: string; app?: WorkshopApp; build?: BuildSummary };
}
export interface Turn { id: string; from: 'you' | 'workshop'; text: string; looked?: string[]; pending?: PendingAct | null }

export interface CatalogInput { key: string; label: string; placeholder?: string }
export interface CatalogSecret { key: string; label: string; hint?: string }
export interface CatalogEntry {
  id: string; label: string; publisher: string; summary: string; caution: string;
  inputs: CatalogInput[]; secrets: CatalogSecret[]; preview: string;
}

export interface StoreSecret { name: string; env: string; description: string; example: string }
export interface StoreServer {
  name: string; title: string; description: string; category: string;
  icon: string | null; image: string; source: string;
  tools: string[]; secrets: StoreSecret[]; pulls: number; stars: number;
}
export interface Store { available: boolean; error: string | null; servers: StoreServer[]; enabled: string[]; secrets?: string[] }
