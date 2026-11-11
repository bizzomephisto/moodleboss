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

async function request(settings, key, route, body, stream = false) {
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
      headers: { Accept: stream ? 'text/event-stream, application/json' : 'application/json',
        ...(body && { 'Content-Type': 'application/json' }), ...auth },
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
  if (stream) return response;
  return readJson(response);
}

async function readJson(response) {
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

async function* streamEvents(body) {
  let buffer = '';
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
    if (buffer.length > 2_000_000) throw new Error('The AI server sent an oversized stream event.');
  }
}

function geminiText(result) {
  return (result.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text ?? '').join('');
}

function textDelta(provider, event) {
  if (provider === 'openai') return event.type === 'response.output_text.delta' ? event.delta : '';
  if (provider === 'gemini') return geminiText(event);
  if (provider === 'claude') {
    if (event.type === 'content_block_start' && event.content_block?.type === 'text') return event.content_block.text;
    return event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? event.delta.text : '';
  }
  return event.choices?.[0]?.delta?.content;
}

function streamFinished(provider, event) {
  if (provider === 'openai') return ['response.completed', 'response.incomplete'].includes(event.type);
  if (provider === 'claude') return event.type === 'message_stop';
  if (provider === 'gemini') return Boolean(event.candidates?.[0]?.finishReason || event.promptFeedback?.blockReason);
  return Boolean(event.choices?.[0]?.finish_reason);
}

async function completion(settings, key, route, body, extract, onText) {
  if (!onText) return extract(await request(settings, key, route, body));
  const response = await request(settings, key, route, body, true);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    return extract(await readJson(response));
  }
  let text = '';
  try {
    for await (const data of streamEvents(response.body)) {
      if (data === '[DONE]') return text;
      const event = JSON.parse(data);
      if (event.error || event.type === 'error' || event.type === 'response.failed') break;
      const delta = textDelta(settings.provider, event);
      if (typeof delta === 'string' && delta) {
        const next = delta.slice(0, 30000 - text.length);
        text += next;
        onText(next);
      }
      if (text.length === 30000 || streamFinished(settings.provider, event)) return text;
    }
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('The AI request timed out. Try again or choose a faster model.');
  }
  throw new Error('The AI response was interrupted. Try sending your message again.');
}

async function complete(settings, key, messages, temperature, maxTokens = 2400, onText) {
  const { provider, model } = settings;
  const [system, ...input] = messages;
  if (provider === 'openai') {
    return completion(settings, key, '/responses', {
      model, instructions: system.content, input, max_output_tokens: maxTokens, store: false,
      ...(onText && { stream: true }),
    }, result => (result.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join(''), onText);
  }
  if (provider === 'gemini') {
    const id = encodeURIComponent(model.replace(/^models\//, ''));
    const method = onText ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return completion(settings, key, `/models/${id}:${method}`, {
      systemInstruction: { parts: [{ text: system.content }] },
      contents: input.map(turn => ({
        role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }],
      })),
      generationConfig: { maxOutputTokens: Math.max(4096, maxTokens) },
    }, geminiText, onText);
  }
  if (provider === 'claude') {
    return completion(settings, key, '/messages', {
      model, system: system.content, messages: input, max_tokens: maxTokens,
      ...(onText && { stream: true }),
    }, result => (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join(''), onText);
  }
  return completion(settings, key, '/chat/completions', {
    model, max_tokens: maxTokens, messages,
    ...(provider !== 'compatible' && temperature !== undefined && { temperature }),
    ...(onText && { stream: true }),
  }, result => result.choices?.[0]?.message?.content, onText);
}

module.exports = { complete, endpoints, hosted, listModels };
