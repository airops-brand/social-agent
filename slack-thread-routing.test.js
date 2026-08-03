const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanThreadRequest,
  formatThreadTranscript,
  isConversationalReply,
  isDirectedAtEdna,
  threadIncludesEdna,
} = require('./slack-thread-routing');

test('accepts replies with no mention or a direct Edna mention', () => {
  assert.equal(isDirectedAtEdna('Can you make this shorter?', 'UEDNA'), true);
  assert.equal(isDirectedAtEdna('<@UEDNA> can you make this shorter?', 'UEDNA'), true);
  assert.equal(isDirectedAtEdna('<@UOTHER> what do you think?', 'UEDNA'), false);
});

test('cleans the Edna mention and ignores conversational replies', () => {
  assert.equal(cleanThreadRequest('<@UEDNA>  Research this', 'UEDNA'), 'Research this');
  assert.equal(isConversationalReply('Sounds good'), true);
  assert.equal(isConversationalReply('Sounds good, but make it shorter'), false);
});

test('recognizes Edna participation and formats bounded context', () => {
  const messages = [
    { user: 'UHUMAN', text: 'Original request' },
    { user: 'UEDNA', text: 'Here is the draft' },
  ];
  assert.equal(threadIncludesEdna(messages, 'UEDNA'), true);
  assert.match(formatThreadTranscript(messages, 'UEDNA'), /Edna: Here is the draft/);
});
