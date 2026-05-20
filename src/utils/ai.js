/**
 * AI utility to interact with OpenRouter using Structured Outputs.
 */

export async function parseTaskWithAI(prompt, apiKey) {
  if (!apiKey) {
    throw new Error('OpenRouter API key is required');
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Planner App',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini', // Cost-effective model that supports structured outputs
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that parses task descriptions into structured JSON. ' +
                   'Priorities are: 🔴 (Urgent & Important), 🟡 (Important), 🔵 (Urgent, Not Important), ⚪ (Low), 🐸 (Frog/Eat First), 📖 (Learning). ' +
                   'Sections are: Today or Deferred.'
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'task_parse',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'The description of the task',
              },
              priority: {
                type: 'string',
                enum: ['🔴', '🟡', '🔵', '⚪', '🐸', '📖'],
                description: 'The priority level as an icon',
              },
              section: {
                type: 'string',
                enum: ['Today', 'Deferred'],
                description: 'Which section the task belongs to',
              },
            },
            required: ['task', 'priority', 'section'],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to call OpenRouter');
  }

  const data = await response.json();
  const content = data.choices[0].message.content;

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('Failed to parse AI response:', content);
    throw new Error('AI returned invalid JSON');
  }
}
