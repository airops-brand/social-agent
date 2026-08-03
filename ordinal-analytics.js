'use strict';

const ORDINAL_ANALYTICS_TOOL_NAMES = new Set([
  'ordinal_get_workspace_context',
  'ordinal_get_analytics',
]);

function isOrdinalAnalyticsRequest(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;

  if (/^(?:draft|write|create)\b.*\b(?:post|copy|caption|thread)\b/.test(value)) return false;

  const mentionsOrdinal = /\bordinal\b/.test(value);
  const asksForGuidance = /\b(?:which|what) metrics should\b|\bshould (?:i|we) track\b|\bbest practices?\b/.test(value);
  if (asksForGuidance && !mentionsOrdinal) return false;

  if (/^(?:analytics|performance report|social report|account report)$/.test(value)) return true;
  if (/\b(?:top|best|worst)[ -]performing posts?\b/.test(value)) return true;
  if (/\bfollower growth\b/.test(value)) return true;

  const hasMetric = /\b(?:analytics|performance|metrics?|impressions?|engagement|engagement rate|followers?|reactions?|likes?|comments?|shares?|reposts?|views?|clicks?|reach)\b/.test(value);
  const asksForData = /\b(?:show|pull|fetch|give|share|report|compare|summari[sz]e|how (?:is|are|did|has|have)|what (?:were|was|are)|top|best|worst)\b/.test(value);

  return hasMetric && (mentionsOrdinal || asksForData);
}

function toAnthropicAnalyticsTools(mcpTools = []) {
  return mcpTools
    .filter((tool) => ORDINAL_ANALYTICS_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description || `Read data using ${tool.name}`,
      input_schema: tool.inputSchema || tool.input_schema || { type: 'object', properties: {} },
    }));
}

function compactOrdinalToolResult(result, maxLength = 30000) {
  const serialized = typeof result === 'string' ? result : JSON.stringify(result);
  const text = serialized === undefined ? String(result ?? '') : serialized;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[Ordinal result truncated]`;
}

function clampSlackMessage(text, maxLength = 3600) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;

  const clipped = value.slice(0, maxLength);
  const lastLineBreak = clipped.lastIndexOf('\n');
  const boundary = lastLineBreak > maxLength * 0.75 ? lastLineBreak : maxLength;
  return `${clipped.slice(0, boundary).trim()}\n\n_Report shortened to fit in Slack._`;
}

module.exports = {
  ORDINAL_ANALYTICS_TOOL_NAMES,
  clampSlackMessage,
  compactOrdinalToolResult,
  isOrdinalAnalyticsRequest,
  toAnthropicAnalyticsTools,
};
