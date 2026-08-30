import OpenAI from 'openai';
import { config } from './config.js';

function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

export class OpenAiLlmService {
  constructor({ model = config.model, apiKey = config.openaiApiKey } = {}) {
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required.');
    }
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  async requestText({ instructions, input, temperature }) {
    const response = await this.client.responses.create({
      model: this.model,
      instructions,
      input,
      temperature,
    });

    const text = response.output_text?.trim();
    if (!text) {
      throw new Error('Model returned an empty response.');
    }

    return text;
  }

  async generateHtml({ appId, spec }) {
    const instructions = [
      'You generate production-ready HTML documents for a sandboxed iframe.',
      'Return only raw HTML. Do not use markdown code fences.',
      'Must include inline CSS and inline JavaScript only (no external dependencies).',
      'Use same-origin fetch calls to /action/<appId>/<action> for backend actions.',
      'Include a visible area for action results and runtime errors.',
      'Keep output deterministic and valid HTML5.',
    ].join(' ');

    const input = [
      `appId: ${appId}`,
      'Spec markdown follows:',
      spec,
      'The app should include a reusable helper:',
      [
        'async function callAction(action, payload) {',
        `  const response = await fetch('/action/${appId}/' + action, {`,
        `    method: 'POST',`,
        `    headers: { 'content-type': 'application/json' },`,
        '    body: JSON.stringify({ payload })',
        '  });',
        '  return response.json();',
        '}',
      ].join('\n'),
    ].join('\n\n');

    const html = await this.requestText({ instructions, input });
    return stripCodeFences(html);
  }

  async generateActionCode({ appId, action, spec, payload }) {
    const instructions = [
      'You generate JavaScript action handlers for server-side execution in a VM sandbox.',
      'Return only JavaScript. No markdown fences.',
      'The code must export async function handler(input, ctx).',
      'Do not use require, process, fs, child_process, dynamic import, or eval.',
      'The return value must be JSON-serializable.',
      'Use defensive checks and clear errors.',
    ].join(' ');

    const input = [
      `appId: ${appId}`,
      `action: ${action}`,
      'Spec markdown follows:',
      spec,
      'Example input payload JSON:',
      JSON.stringify(payload ?? {}, null, 2),
    ].join('\n\n');

    const code = await this.requestText({ instructions, input });
    return stripCodeFences(code);
  }

  async repairActionCode({ appId, action, spec, payload, previousCode, error }) {
    const instructions = [
      'Repair JavaScript action code after a deterministic runtime or syntax failure.',
      'Return only corrected JavaScript. No markdown fences.',
      'The code must export async function handler(input, ctx).',
      'Do not use require, process, fs, child_process, dynamic import, or eval.',
      'Keep the same action intent but fix the failure.',
    ].join(' ');

    const input = [
      `appId: ${appId}`,
      `action: ${action}`,
      'Spec markdown follows:',
      spec,
      'Input payload JSON:',
      JSON.stringify(payload ?? {}, null, 2),
      'Failing code:',
      previousCode,
      'Failure:',
      String(error),
    ].join('\n\n');

    const code = await this.requestText({ instructions, input });
    return stripCodeFences(code);
  }
}
