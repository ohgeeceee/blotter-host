'use strict';

function resolveOpenRouter() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) return null;
  const baseUrl = String(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = String(process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free').trim();
  return { apiKey, baseUrl, model };
}

async function callOpenRouter({ apiKey, baseUrl, model }, prompt) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: parseInt(process.env.OPENROUTER_MAX_TOKENS || '1200', 10),
      messages: [
        { role: 'system', content: prompt.system },
        ...prompt.messages,
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error('OpenRouter returned no content');
  return { content: String(content) };
}

module.exports = {
  resolveOpenRouter,
  callOpenRouter,
};
