import OpenAI from 'openai';

export interface LlmJsonRequest {
  systemPrompt: string;
  userPrompt: string;
}

/** Token accounting reported by the OpenAI-compatible provider. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmJsonResult {
  data: unknown;
  usage: LlmUsage | null;
}

/**
 * Sends a prompt to the configured OpenAI-compatible model and returns its
 * JSON response plus the provider-reported token usage. Deliberately free of
 * any domain logic so it can be reused by other agents.
 */
export async function callLlmJsonWithUsage({
  systemPrompt,
  userPrompt,
}: LlmJsonRequest): Promise<LlmJsonResult> {
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

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned an empty response');
  }

  const usage = completion.usage
    ? {
        promptTokens: completion.usage.prompt_tokens ?? 0,
        completionTokens: completion.usage.completion_tokens ?? 0,
        totalTokens: completion.usage.total_tokens ?? 0,
      }
    : null;

  try {
    return { data: JSON.parse(content), usage };
  } catch {
    throw new Error('LLM returned invalid JSON');
  }
}

/**
 * Convenience wrapper for callers that do not care about token metering.
 */
export async function callLlmJson(request: LlmJsonRequest): Promise<unknown> {
  return (await callLlmJsonWithUsage(request)).data;
}
