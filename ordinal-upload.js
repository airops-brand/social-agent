async function postSignedOrdinalUpload({ upload, buffer, filename, mimetype, fetchImpl = fetch }) {
  if (!upload?.uploadUrl || upload.params === undefined || !upload.signature) {
    throw new Error('Ordinal did not return complete signed upload credentials');
  }

  const formData = new FormData();
  formData.append(
    'params',
    typeof upload.params === 'string' ? upload.params : JSON.stringify(upload.params),
  );
  formData.append('signature', upload.signature);
  formData.append('file', new Blob([buffer], { type: mimetype }), filename);

  const response = await fetchImpl(upload.uploadUrl, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(
      `Ordinal signed upload failed (${response.status})${details ? `: ${details.slice(0, 500)}` : ''}`,
    );
  }
}

module.exports = { postSignedOrdinalUpload };
