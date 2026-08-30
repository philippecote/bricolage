# Workshop app contract

Build a polished, dependency-free mini-app. You may only edit files in this workspace.

Load and follow the workshop-app-builder skill in .codex/skills/workshop-app-builder/SKILL.md. A new app begins with a shaping turn that returns the skill's JSON brief and writes nothing; the build request that follows carries the person's answers.

- Write the complete app to runtime/index.html with inline CSS and JavaScript.
- Update manifest.json without changing id, createdAt, threadId, revision, or status.
- Use window.Workshop.callAction(name, payload), notify(message), setTitle(title), and storage.get/set.
- For server work, add actions/<name>.js exporting async function handler(input, ctx), then list the action in manifest.actions.
- ctx.fetch(url, options) reaches public HTTPS APIs; ctx.storage.get/set provide durable JSON state.
- Never install dependencies, run a dev server, embed secrets, or access files outside this workspace.
- Design for a 900x650 window, include loading/error/empty states, and use semantic accessible HTML.
