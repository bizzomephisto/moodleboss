const hosted = Object.freeze({
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  claude: 'https://api.anthropic.com/v1',
});
const endpoints = Object.freeze({
  lmstudio: 'http://127.0.0.1:1234/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  compatible: hosted.openai,
  ...hosted,
});

async function request(settings, key, route, body) {
  const { provider, endpoint } = settings;
  if (Object.hasOwn(hosted, provider) && !key) {
    throw new Error('Enter the API key for this provider in Settings.');
  }
  const auth = provider === 'gemini' ? { 'x-goog-api-key': key } :
    provider === 'claude' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } :
    key ? { Authorization: `Bearer ${key}` } : {};
  let response;
  try {
    response = await fetch(endpoint + route, {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }), ...auth },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('The AI request timed out. Try again or choose a faster model.');
    throw new Error('Could not reach the AI endpoint. Check the connection and API base URL.');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('The AI server rejected the API key or access permissions.');
    if (response.status === 429) throw new Error('The AI server returned HTTP 429. Check your rate limits or API quota.');
    throw new Error(`The AI server returned HTTP ${response.status}. Check the endpoint and model.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('The AI server did not return JSON. Check the API base URL.');
  }
}

async function listModels(settings, key) {
  const { provider } = settings;
  const ids = new Set();
  const cursors = new Set();
  let query = '';
  do {
    const result = await request(settings, key, '/models' + query);
    const models = provider === 'gemini' ? result?.models ?? [] : result?.data;
    if (!Array.isArray(models)) throw new Error('The provider did not return a model list.');
    for (const model of models) {
      const id = provider === 'gemini'
        ? model?.supportedGenerationMethods?.includes('generateContent') && model?.name?.replace(/^models\//, '')
        : model?.id;
      if (typeof id === 'string' && id.trim() && id.length <= 240) ids.add(id);
    }
    const cursor = provider === 'gemini' ? result.nextPageToken : provider === 'claude' && result.has_more && result.last_id;
    query = cursor ? '?' + new URLSearchParams({ [provider === 'gemini' ? 'pageToken' : 'after_id']: cursor }) : '';
    if (query && cursors.has(query)) throw new Error('The provider repeated a model list page.');
    cursors.add(query);
  } while (query);
  return [...ids].sort();
}

async function complete(settings, key, messages, temperature, maxTokens = 2400) {
  const { provider, model } = settings;
  const [system, ...input] = messages;
  if (provider === 'openai') {
    const result = await request(settings, key, '/responses', {
      model, instructions: system.content, input, max_output_tokens: maxTokens, store: false,
    });
    return (result.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  }
  if (provider === 'gemini') {
    const id = encodeURIComponent(model.replace(/^models\//, ''));
    const result = await request(settings, key, `/models/${id}:generateContent`, {
      systemInstruction: { parts: [{ text: system.content }] },
      contents: input.map(turn => ({
        role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }],
      })),
      generationConfig: { maxOutputTokens: Math.max(4096, maxTokens) },
    });
    return (result.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text ?? '').join('');
  }
  if (provider === 'claude') {
    const result = await request(settings, key, '/messages', {
      model, system: system.content, messages: input, max_tokens: maxTokens,
    });
    return (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('');
  }
  const result = await request(settings, key, '/chat/completions', {
    model, max_tokens: maxTokens, messages,
    ...(provider !== 'compatible' && temperature !== undefined && { temperature }),
  });
  return result.choices?.[0]?.message?.content;
}

module.exports = { complete, endpoints, hosted, listModels };
