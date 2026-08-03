const CONVERSATIONAL_REPLIES = new Set([
  'thanks',
  'thank you',
  'ok',
  'got it',
  'sounds good',
  'nice',
  'cool',
  'lol',
  'haha',
  'yes',
  'no',
  'yep',
  'nope',
  'agreed',
  'perfect',
]);

function cleanThreadRequest(text, ednaUserId) {
  const mention = ednaUserId ? new RegExp(`<@${ednaUserId}>`, 'g') : null;
  return String(text || '')
    .replace(mention || /$^/, '')
    .trim();
}

function isConversationalReply(text) {
  return CONVERSATIONAL_REPLIES.has(String(text || '').trim().toLowerCase());
}

function isDirectedAtEdna(text, ednaUserId) {
  const mentions = Array.from(String(text || '').matchAll(/<@([UW][A-Z0-9]+)>/g), (match) => match[1]);
  return mentions.length === 0 || Boolean(ednaUserId && mentions.includes(ednaUserId));
}

function threadIncludesEdna(messages, ednaUserId) {
  return Boolean(ednaUserId && (messages || []).some((message) => message.user === ednaUserId));
}

function formatThreadTranscript(messages, ednaUserId) {
  return (messages || [])
    .slice(-30)
    .map((message) => {
      const speaker = message.user === ednaUserId ? 'Edna' : `Slack user ${message.user || 'unknown'}`;
      return `${speaker}: ${String(message.text || '').slice(0, 2000)}`;
    })
    .join('\n\n')
    .slice(-16000);
}

module.exports = {
  cleanThreadRequest,
  formatThreadTranscript,
  isConversationalReply,
  isDirectedAtEdna,
  threadIncludesEdna,
};
