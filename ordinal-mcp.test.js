const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EncryptedJsonStore,
  RailwayOAuthProvider,
  parseToolResult,
} = require('./ordinal-mcp');

test('OAuth credentials are encrypted and survive provider recreation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edna-ordinal-'));
  const filePath = path.join(directory, 'credentials.json');
  const key = Buffer.alloc(32, 7).toString('base64');
  const store = new EncryptedJsonStore(filePath, key);
  const provider = new RailwayOAuthProvider(store, 'https://example.com/ordinal/oauth/callback');

  provider.saveTokens({ access_token: 'secret-access-token', token_type: 'bearer' });
  provider.saveCodeVerifier('secret-code-verifier');

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(raw, /secret-access-token/);
  assert.doesNotMatch(raw, /secret-code-verifier/);

  const recreated = new RailwayOAuthProvider(
    new EncryptedJsonStore(filePath, key),
    'https://example.com/ordinal/oauth/callback',
  );
  assert.equal(recreated.tokens().access_token, 'secret-access-token');
  assert.equal(recreated.codeVerifier(), 'secret-code-verifier');
});

test('tool results prefer structured content and surface tool errors', () => {
  assert.deepEqual(
    parseToolResult({ structuredContent: { id: 'post-1' }, content: [] }),
    { id: 'post-1' },
  );
  assert.deepEqual(
    parseToolResult({ content: [{ type: 'text', text: '{"id":"post-2"}' }] }),
    { id: 'post-2' },
  );
  assert.throws(
    () => parseToolResult({ isError: true, content: [{ type: 'text', text: 'denied' }] }),
    /denied/,
  );
});
