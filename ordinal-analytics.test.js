'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clampSlackMessage,
  compactOrdinalToolResult,
  isOrdinalAnalyticsRequest,
  toAnthropicAnalyticsTools,
} = require('./ordinal-analytics');

test('recognizes direct Ordinal analytics requests', () => {
  assert.equal(isOrdinalAnalyticsRequest('Show me Alex\'s engagement last month'), true);
  assert.equal(isOrdinalAnalyticsRequest('What were our top-performing posts this quarter?'), true);
  assert.equal(isOrdinalAnalyticsRequest('Give me follower growth for all accounts'), true);
  assert.equal(isOrdinalAnalyticsRequest('analytics'), true);
});

test('does not route general measurement advice into live analytics', () => {
  assert.equal(isOrdinalAnalyticsRequest('What metrics should we track on LinkedIn?'), false);
  assert.equal(isOrdinalAnalyticsRequest('What are social analytics best practices?'), false);
  assert.equal(isOrdinalAnalyticsRequest('Draft a post about follower growth'), false);
});

test('exposes only read-only Ordinal analytics tools to Claude', () => {
  const tools = toAnthropicAnalyticsTools([
    { name: 'ordinal_get_workspace_context', inputSchema: { type: 'object' } },
    { name: 'ordinal_get_analytics', inputSchema: { type: 'object' } },
    { name: 'ordinal_create_post', inputSchema: { type: 'object' } },
  ]);

  assert.deepEqual(tools.map((tool) => tool.name), [
    'ordinal_get_workspace_context',
    'ordinal_get_analytics',
  ]);
  assert.ok(tools.every((tool) => tool.input_schema.type === 'object'));
});

test('bounds Ordinal tool data and final Slack reports', () => {
  assert.match(compactOrdinalToolResult({ data: 'x'.repeat(100) }, 30), /truncated/);
  assert.match(clampSlackMessage('x'.repeat(100), 30), /shortened/);
});
