const test = require('node:test');
const assert = require('node:assert/strict');
const { removeHashtags } = require('./draft-cleanup');

test('removes a trailing hashtag-only line from a post draft', () => {
  assert.equal(
    removeHashtags('A useful post.\n\n#AEO #ContentEngineering #AISearch'),
    'A useful post.',
  );
});

test('turns an inline hashtag into normal copy', () => {
  assert.equal(
    removeHashtags('Strong AEO programs need #ContentEngineering to work.'),
    'Strong AEO programs need ContentEngineering to work.',
  );
});

test('leaves ordinary number signs alone', () => {
  assert.equal(removeHashtags('Priority #1 is customer proof.'), 'Priority #1 is customer proof.');
});
