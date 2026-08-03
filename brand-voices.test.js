'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AIROPS_BRAND_KIT_ID,
  VOICE_OPTIONS,
  getFormVoiceKey,
  normalizeVoiceChoice,
} = require('./brand-voices');

test('maps each workflow option to its configured brand voice', () => {
  assert.equal(normalizeVoiceChoice('alex'), 'alex');
  assert.equal(normalizeVoiceChoice('Matt'), 'matt');
  assert.equal(normalizeVoiceChoice('*Christy Roach*'), 'christy');
  assert.equal(normalizeVoiceChoice('Brand'), 'airops');
});

test('reads the exact Slack workflow question label', () => {
  assert.equal(getFormVoiceKey({
    'whose brand voice should this be in?': 'Alex Halliday',
  }), 'alex');
});

test('returns no override when the workflow field is absent or unknown', () => {
  assert.equal(getFormVoiceKey({}), null);
  assert.equal(getFormVoiceKey({ 'brand voice': 'Someone else' }), null);
});

test('keeps every voice in the same AirOps brand kit with a unique content type', () => {
  const voices = Object.values(VOICE_OPTIONS);
  assert.ok(voices.every((voice) => voice.brandKitId === AIROPS_BRAND_KIT_ID));
  assert.equal(new Set(voices.map((voice) => voice.contentTypeId)).size, voices.length);
});
