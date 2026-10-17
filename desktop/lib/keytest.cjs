// "Test" buttons in Settings: one cheap, read-only request per service, answered in plain words.

async function get(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  return r.status;
}

const verdict = (status, what) => {
  if (status >= 200 && status < 300) return { ok: true, message: `${what} accepted the key.` };
  if (status === 401 || status === 403) return { ok: false, message: `${what} rejected the key. Check it was copied completely.` };
  if (status === 404) return { ok: false, message: `${what} answered "not found". Check the ID you entered.` };
  return { ok: false, message: `${what} answered with an error (${status}). Try again in a minute.` };
};

async function test(kind, v) {
  try {
    switch (kind) {
      case 'anthropic':
        if (!v.key) return { ok: false, message: 'Enter the key first.' };
        return verdict(await get('https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': v.key, 'anthropic-version': '2023-06-01' }), 'Anthropic');
      case 'openai':
        if (!v.key) return { ok: false, message: 'Enter the key first.' };
        return verdict(await get('https://api.openai.com/v1/models', { authorization: `Bearer ${v.key}` }), 'OpenAI');
      case 'gemini':
        if (!v.key) return { ok: false, message: 'Enter the key first.' };
        return verdict(await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(v.key)}`, {}), 'Google');
      case 'runpod':
        if (!v.key || !v.endpointId) return { ok: false, message: 'Enter both the API key and the endpoint ID first.' };
        return verdict(await get(`https://rest.runpod.io/v1/endpoints/${encodeURIComponent(v.endpointId)}`, { authorization: `Bearer ${v.key}` }), 'RunPod');
      default:
        return { ok: false, message: 'Nothing to test.' };
    }
  } catch (e) {
    return { ok: false, message: e && e.name === 'TimeoutError' ? 'No answer after 15 seconds. Check your internet connection.' : 'Could not reach the service. Check your internet connection.' };
  }
}

module.exports = { test, verdict };
