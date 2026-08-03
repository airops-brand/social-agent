const HASHTAG_TOKEN = '#[\\p{L}_][\\p{L}\\p{N}_]*';
const HASHTAG_ONLY_LINE = new RegExp(`^(?:${HASHTAG_TOKEN}[.,;:!?]?\\s*)+$`, 'u');
const INLINE_HASHTAG_MARKER = /#(?=[\p{L}_])/gu;

function removeHashtags(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !HASHTAG_ONLY_LINE.test(line.trim()))
    .map((line) => line.replace(INLINE_HASHTAG_MARKER, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { removeHashtags };
