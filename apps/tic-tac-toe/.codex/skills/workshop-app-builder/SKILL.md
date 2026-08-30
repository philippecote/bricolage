---
name: workshop-app-builder
description: Shape, plan, implement, and verify dependency-free Workshop mini-apps from natural-language requests. Use for every new Workshop app and follow-up edit.
---

# Workshop App Builder

Turn a personal app idea into a polished, dependable mini-app without exposing implementation complexity to the user.

## Working rhythm

1. Shape the idea. A new app starts with a shaping turn that produces the JSON brief below; Workshop shows your questions to the person and hands their answers back. Follow-up edits skip shaping.
2. Make a compact plan. Three to five outcome-oriented steps, including one that verifies the primary user journey.
3. Implement the complete experience. Keep the first usable version small, cohesive, and visually intentional. Preserve working behavior during follow-up edits.
4. Check the result. Validate JavaScript syntax, exercise the main interaction, and confirm loading, empty, error, and saved-state behavior where relevant.
5. Finish clearly. Summarize what changed and what was checked. Do not leave the user wondering whether work is still running.

## The shaping turn

When Workshop asks you to shape a request, that turn is for thinking only. Read files if it helps; write nothing, run nothing. Reply with a single ```json fenced block and no other prose:

```json
{
  "name": "Short app name, at most four words",
  "summary": "One sentence describing the app you intend to build",
  "questions": [
    { "id": "kebab-case-id", "prompt": "A short plain-language question", "options": ["Concrete choice", "Concrete choice", "Concrete choice"] }
  ],
  "plan": ["Three to five outcome-oriented steps"]
}
```

Question rules — these are what the person actually sees, so they carry the product:

- At most three. Use an empty array when the request already determines the product.
- Every question must be a real fork in *this* app. "Which pieces of a workout does it log?" is a question; "What mood should it have?" is not.
- Never ask generic questions about tone, audience, personality, or speed, and never ask anything technical — frameworks, storage, file layout, hosting.
- Two to four options each, every option a concrete choice under 42 characters that a non-technical person can pick instantly.
- Prefer the decision that is expensive to reverse later. Choose the rest yourself.

## Reaching for the model

`ctx.llm.ask` inside an action is the way an app thinks at runtime. Use it where judgment genuinely beats code — summarizing, extracting structure from messy input, ranking, drafting, answering from the live web — and not where a plain function would do.

```js
export async function handler(input, ctx) {
  const { output, sources } = await ctx.llm.ask({
    prompt: `Extract the shopping items from: ${input.text}`,
    schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
    search: false,
  });
  return { items: output.items, sources };
}
```

- Always pass a schema when the app needs to render the result. Parsing prose in the runtime is a bug waiting to happen.
- Leave search on for questions about the world; turn it off for anything derived from the user's own content.
- Surface `sources` in the interface whenever an answer came from the web, and design a visible loading state — these calls take a second or two.
- Handle the failure: a model call can time out or return unusable JSON, and the app must stay usable when it does.

## Product judgment

- Prefer a focused app with one excellent workflow over a collection of shallow features.
- Make useful assumptions when they are reversible; surface only decisions that materially change the product.
- Treat the answers as design inputs, not copy to repeat in the interface.
- Use concise product language, strong hierarchy, restrained motion, and visible interaction feedback.
- Do not expose raw JSON, developer controls, build terminology, or placeholder content in the finished app.

Follow the workspace's `AGENTS.md` for the runtime and security contract.
