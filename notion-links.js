function compactNotionId(id) {
  return String(id || '').replace(/-/g, '');
}

function notionBlockUrl(pageId, blockId) {
  const pageUrl = `https://www.notion.so/${compactNotionId(pageId)}`;
  return blockId ? `${pageUrl}#${compactNotionId(blockId)}` : pageUrl;
}

function findHeadingBlockId(blocks, headingText) {
  const expected = headingText.trim().toLowerCase();
  const block = (blocks || []).find((candidate) => {
    if (!candidate || !candidate.type?.startsWith('heading_')) return false;
    const richText = candidate[candidate.type]?.rich_text || [];
    const text = richText
      .map((item) => item.plain_text || item.text?.content || '')
      .join('')
      .trim()
      .toLowerCase();
    return text === expected;
  });
  return block?.id || null;
}

module.exports = { findHeadingBlockId, notionBlockUrl };
