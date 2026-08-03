const test = require('node:test');
const assert = require('node:assert/strict');
const { postSignedOrdinalUpload } = require('./ordinal-upload');

test('posts Slack file bytes with Ordinal signed upload credentials', async () => {
  let request;
  await postSignedOrdinalUpload({
    upload: {
      uploadUrl: 'https://uploads.example.com/assemblies',
      params: { template_id: 'template', fields: { uploadId: '123' } },
      signature: 'signed',
    },
    buffer: Buffer.from('image bytes'),
    filename: 'draft.png',
    mimetype: 'image/png',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200 };
    },
  });

  assert.equal(request.url, 'https://uploads.example.com/assemblies');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body.get('signature'), 'signed');
  assert.equal(
    request.options.body.get('params'),
    JSON.stringify({ template_id: 'template', fields: { uploadId: '123' } }),
  );

  const file = request.options.body.get('file');
  assert.equal(file.name, 'draft.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.size, Buffer.byteLength('image bytes'));
});

test('surfaces signed upload HTTP failures', async () => {
  await assert.rejects(
    postSignedOrdinalUpload({
      upload: {
        uploadUrl: 'https://uploads.example.com/assemblies',
        params: '{}',
        signature: 'signed',
      },
      buffer: Buffer.from('x'),
      filename: 'draft.png',
      mimetype: 'image/png',
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        text: async () => 'signature expired',
      }),
    }),
    /Ordinal signed upload failed \(403\): signature expired/,
  );
});
