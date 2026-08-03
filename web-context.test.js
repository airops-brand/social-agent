const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPublicWebUrl,
  extractHtmlContext,
  extractWebUrls,
  fetchWebPageContext,
} = require('./web-context');

const publicResolver = async () => [{ address: '93.184.216.34' }];

test('extracts and deduplicates web URLs from a brief', () => {
  assert.deepEqual(
    extractWebUrls('Read https://example.com/a. Then <https://example.com/a|Article> and <https://example.com/b>.'),
    ['https://example.com/a', 'https://example.com/b'],
  );
});

test('extracts useful webpage text and removes scripts', () => {
  const result = extractHtmlContext(
    '<html><head><title>Useful page</title><meta name="description" content="Key context"></head><body><script>ignore me</script><h1>Main claim</h1><p>Proof point.</p></body></html>',
    'https://example.com',
  );
  assert.equal(result.title, 'Useful page');
  assert.equal(result.description, 'Key context');
  assert.match(result.content, /Main claim Proof point/);
  assert.doesNotMatch(result.content, /ignore me/);
});

test('blocks private destinations', async () => {
  await assert.rejects(assertPublicWebUrl('http://127.0.0.1/admin'), /Private URLs/);
  await assert.rejects(
    assertPublicWebUrl('https://example.com', async () => [{ address: '10.0.0.5' }]),
    /Private URLs/,
  );
});

test('fetches a public HTML page for drafting context', async () => {
  const result = await fetchWebPageContext('https://example.com/article', {
    resolveAddresses: publicResolver,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<title>Article</title><main>Specific evidence.</main>',
    }),
  });
  assert.equal(result.title, 'Article');
  assert.match(result.content, /Specific evidence/);
});
