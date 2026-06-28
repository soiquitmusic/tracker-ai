// ===== providers.js — API 提供商层 (Gemini / OpenAI / Claude 流式) =====

export const PRESETS = {
  deepseek: { provider: 'openai_compat', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat', vision: false },
  kimi:     { provider: 'openai_compat', base_url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', vision: false },
  'qwen(文本)':    { provider: 'openai_compat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', vision: false },
  'qwen(视觉)':  { provider: 'openai_compat', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max-latest', vision: true },
  openai:   { provider: 'openai_compat', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision: true },
  gemini:   { provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', vision: true },
  claude:   { provider: 'claude', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514', vision: true },
};

// ---------- 统一入口 ----------

export async function* streamChat(messages, profile) {
  if (!profile || !profile.api_key) throw new Error('未配置 API Key');
  try {
    switch (profile.provider) {
      case 'gemini': yield* streamGemini(messages, profile); break;
      case 'openai_compat': yield* streamOpenAI(messages, profile); break;
      case 'claude': yield* streamClaude(messages, profile); break;
      default: throw new Error(`不支持的 provider: ${profile.provider}`);
    }
  } catch (e) {
    if (e instanceof TypeError && e.message.includes('Failed to fetch')) {
      throw new Error(`网络请求失败（可能是 CORS 限制）。\n如果使用非 Gemini 的 API，请在设置中将 Base URL 改为支持 CORS 的代理地址。`);
    }
    throw e;
  }
}

// ---------- SSE 解析器 ----------

async function* parseSSE(response) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API 错误 (${response.status}): ${text.slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        yield data;
      }
    }
  }
  if (buffer.trim().startsWith('data: ')) {
    const data = buffer.trim().slice(6);
    if (data !== '[DONE]') yield data;
  }
}

// ---------- Gemini ----------

function buildGeminiContents(messages) {
  let sysText = '';
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') { sysText += m.content + '\n'; continue; }
    if (m.role === 'user') {
      const text = sysText ? sysText + m.content : m.content;
      sysText = '';
      const parts = [];
      if (text) parts.push({ text });
      for (const a of (m.attachments || [])) {
        if (a.type === 'image' && a.data) {
          parts.push({ inline_data: { mime_type: a.mime || 'image/png', data: a.data } });
        }
      }
      contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
    } else if (m.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: m.content }] });
    }
  }
  return contents;
}

async function* streamGemini(messages, config) {
  const contents = buildGeminiContents(messages);
  const url = `${config.base_url.replace(/\/$/, '')}/v1beta/models/${config.model}:streamGenerateContent?alt=sse&key=${config.api_key}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents }),
  });

  for await (const data of parseSSE(resp)) {
    try {
      const json = JSON.parse(data);
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) yield text;
    } catch {}
  }
}

// ---------- OpenAI 兼容 ----------

async function* streamOpenAI(messages, config) {
  const url = `${config.base_url.replace(/\/$/, '')}/chat/completions`;
  const cleaned = messages.map(m => {
    const attachments = m.attachments || [];
    const images = attachments.filter(a => a.type === 'image' && a.data);
    if (images.length > 0) {
      // OpenAI Vision 格式（Qwen-VL 也兼容）— 图片放前面，模型识别更好
      const content = [];
      for (const img of images) {
        content.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/jpeg'};base64,${img.data}` } });
      }
      if (m.content) content.push({ type: 'text', text: m.content });
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: cleaned,
      temperature: 0.6,
      stream: true,
    }),
  });

  for await (const data of parseSSE(resp)) {
    try {
      const json = JSON.parse(data);
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) yield delta;
    } catch {}
  }
}

// ---------- Claude ----------

async function* streamClaude(messages, config) {
  const url = `${config.base_url.replace(/\/$/, '')}/v1/messages`;
  const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const chatMsgs = messages.filter(m => m.role !== 'system')
    .map(m => ({ role: m.role, content: m.content }));

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': config.api_key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 4096,
      system: systemText || undefined,
      messages: chatMsgs,
      stream: true,
    }),
  });

  for await (const data of parseSSE(resp)) {
    try {
      const json = JSON.parse(data);
      if (json.type === 'content_block_delta') {
        const text = json.delta?.text;
        if (text) yield text;
      }
    } catch {}
  }
}
