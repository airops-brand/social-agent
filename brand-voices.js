'use strict';

const AIROPS_BRAND_KIT_ID = 26564;

const VOICE_OPTIONS = {
  airops: {
    label: 'AirOps Brand',
    brandKitId: AIROPS_BRAND_KIT_ID,
    contentTypeId: 23019,
  },
  alex: {
    label: 'Alex Halliday',
    brandKitId: AIROPS_BRAND_KIT_ID,
    contentTypeId: 23020,
  },
  christy: {
    label: 'Christy Roach',
    brandKitId: AIROPS_BRAND_KIT_ID,
    contentTypeId: 26745,
  },
  matt: {
    label: 'Matt Hammel',
    brandKitId: AIROPS_BRAND_KIT_ID,
    contentTypeId: 23015,
  },
};

function normalizeVoiceChoice(value) {
  const choice = String(value || '')
    .toLowerCase()
    .replace(/[*_`]/g, '')
    .trim();

  if (/\balex\b/.test(choice)) return 'alex';
  if (/\bmatt\b/.test(choice)) return 'matt';
  if (/\bchristy\b/.test(choice)) return 'christy';
  if (/\bbrand\b/.test(choice) || /\bairops\b/.test(choice)) return 'airops';
  return null;
}

function getFormVoiceKey(fields = {}) {
  const value = fields['whose brand voice should this be in?']
    || fields['whose brand voice should this be in']
    || fields['brand voice']
    || fields.voice;

  return normalizeVoiceChoice(value);
}

module.exports = {
  AIROPS_BRAND_KIT_ID,
  VOICE_OPTIONS,
  getFormVoiceKey,
  normalizeVoiceChoice,
};
