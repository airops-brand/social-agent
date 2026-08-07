const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanThreadRequest,
  formatThreadTranscript,
  isApprovalRequest,
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

test('recognizes explicit approval requests without treating revision feedback as approval', () => {
  assert.equal(isApprovalRequest('approved'), true);
  assert.equal(isApprovalRequest('I made live edits in Notion and it is good to go'), true);
  assert.equal(isApprovalRequest('Can you schedule this to Ordinal now?'), true);
  assert.equal(isApprovalRequest('Ready to publish.'), true);
  assert.equal(isApprovalRequest('This was approved by legal, but make the hook shorter'), false);
});

test('recognizes Edna participation and formats bounded context', () => {
  const messages = [
    { user: 'UHUMAN', text: 'Original request' },
    { user: 'UEDNA', text: 'Here is the draft' },
  ];
  assert.equal(threadIncludesEdna(messages, 'UEDNA'), true);
  assert.match(formatThreadTranscript(messages, 'UEDNA'), /Edna: Here is the draft/);
});
