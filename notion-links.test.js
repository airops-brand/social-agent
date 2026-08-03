const test = require('node:test');
const assert = require('node:assert/strict');
const { findHeadingBlockId, notionBlockUrl } = require('./notion-links');

test('builds a Notion deep link to a specific block', () => {
  assert.equal(
    notionBlockUrl(
      '33b1f419-db8a-8032-aed0-f980166410d2',
      '6a614d76-23c3-4bd5-a4fc-24dcef034314',
    ),
    'https://www.notion.so/33b1f419db8a8032aed0f980166410d2#6a614d7623c34bd5a4fc24dcef034314',
  );
});

test('finds the LinkedIn draft heading returned by Notion', () => {
  const blocks = [
    {
      id: 'first',
      type: 'heading_3',
      heading_3: { rich_text: [{ plain_text: 'Original nugget' }] },
    },
    {
      id: 'draft-block',
      type: 'heading_3',
      heading_3: { rich_text: [{ text: { content: 'LinkedIn post draft' } }] },
    },
  ];

  assert.equal(findHeadingBlockId(blocks, 'LinkedIn post draft'), 'draft-block');
});
