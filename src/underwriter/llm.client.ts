import OpenAI from 'openai';

export interface LlmJsonRequest {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Sends a prompt to the configured OpenAI-compatible model and returns its JSON
 * response. This function deliberately contains no underwriting or validation
 * logic, so it can be reused by other agents.
 */
export async function callLlmJson({ systemPrompt, userPrompt }: LlmJsonRequest): Promise<unknown> {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;

  if (!baseURL || !apiKey || !model) {
    throw new Error('LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL must be configured');
  }

  const client = new OpenAI({ baseURL, apiKey });
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2
  });

  const content = completion.choices[0]?.message.content;
  if (!content) {
    throw new Error('LLM returned an empty response');
  }

  try {
    return JSON.parse(content);
  } catch {
    throw new Error('LLM returned invalid JSON');
  }
}
