# Vision

## The claim

**Software is about to become cheap enough to be personal.** Not personalized — *personal*. Made for one person, by that person, in an afternoon, and thrown away when it stops being useful.

We don't have a place to put that software. We have chat windows, which forget, and app stores, which are for products. Bricolage is an attempt at the missing place.

## What a desktop has that a chat window doesn't

A chatbot and you never touch the same object. You describe a thing; it produces text about that thing; you re-describe. Every reference is symbolic, which is why conversations about anything visual decay into "no, the *other* one."

A desktop has a shared, manipulable surface: objects with identity, position, and state that both parties can point at **and act on**. That's the asset, and most of what's interesting here comes from spending it.

## The model gets out of the way

A chatbot with generative UI puts the model on the critical path of **every** interaction. Every render is a fresh inference — slow, metered, non-deterministic, gone when you scroll. Ask twice, get two different widgets.

Bricolage puts it there **once**. The build is manufacturing, not latency. Afterwards you hold something that opens instantly, runs offline, costs nothing, and behaves the same every time.

That reframes the whole product. Slow builds aren't a UX failure to be optimized away; they're the cost of fabrication, paid once. What matters is that the wait is *legible* — which is why the preview streams and the feed carries the agent's own words rather than a spinner and a canned phrase.

## Apps as crystallized intentions

An app here isn't a document or a chat artifact. It's a **decision you made, made durable**.

It has a filename, an icon, a place on screen, its own data, and a version history. It remembers the three questions you answered when it was shaped. You can roll it back. You'll use it two hundred times without an AI in the loop, and then one day say "also track page counts" and it will change.

Software that stays soft after it ships.

## A partner, not a builder

The desktop agent is not a router that turns sentences into build jobs. It reads your library and your data before it speaks, and most turns produce no software at all.

Asked *"help me figure out what would help with my week"*, it read three apps and answered:

> The main thing that would help this week isn't another productivity app — you've already completed all 8 tasks in your task manager, and your mood log only has one recent entry ("calm" on August 29). […] What kind of week are you trying to have?

That turn built nothing and ended with a question. **What separates a partner from a chatbot is grounding and hands, not turn count.** A conversation that can't see your data or touch your apps is a text box with a nicer prompt.

## Where this goes

### The agent should use the apps

Today the agent writes apps it will never see, and you use apps it can't touch. Two parties, one workspace, zero overlap.

If it could operate an app's interface — the same buttons you use, visibly, in the window you're looking at — three things follow that no chatbot has:

- **Verification stops being a lie.** "Checking every important path" is currently a syntax check. The agent has never run the app it built. It could click through the journey it just shaped with you.
- **Demonstration replaces description.** Not a paragraph about what it made. *"Here, watch."*
- **Delegation lands inside your own tools**, through the same surface you'd use, so you can see exactly what it did and undo it the same way.

And a safety idea falls out for free: **the app's interface becomes the permission boundary.** We currently gate agents with tool allowlists — a developer's mental model that users can't evaluate. If the agent acts through the UI, it can only do what the UI affords. It cannot delete your data unless there's a delete button. "It can do what I can do in this window" is something a person can actually reason about. Affordances instead of allowlists.

### Apps should be able to use each other

`data.json` per app is a hard wall — correct as a default, a mistake as a permanent state. The desktop emerges when one app can ask to read another's data, granted once and revocable. The connection layer is built; the capability graph between apps is not.

### It should remember

Conversations die on restart. For something that claims to understand you and your ecosystem, that's the wrong shape. A partner should remember across sessions, and eventually notice patterns across weeks.

### Things should happen without you

Nothing is agentic if it only runs when clicked. Scheduled and event triggers — *"every Monday, summarise my issues"* — are cheap now that the activity rail exists to show what woke up.

## What we're deliberately not building

**A chat panel that owns the screen.** The transcript would compete with your windows for attention, and demote the apps to output beside the "real" conversation. That's the trade every AI product has already made. The conversation lives under the composer, close to where you typed, and the desktop stays the thing on screen.

**A general assistant.** If a conversation can end with nothing — no answer, no app, no change — it's a chatbot. Exploration is welcome; it should still terminate in something on your desktop, even if that something is just a better question.

**An app store.** These apps are worth exactly one person's needs. The value is that they're disposable.

## The honest state

It builds real apps that do real things, with two different coding agents, and the partner grounds its answers in your actual data.

Actions run in a process that cannot read a file, spawn anything, or open a socket, and an action that has read untrusted content loses the ability to write to the outside world for the rest of that run. Both are enforced, and both are tested.

What remains is narrower: an MCP server added outside the Docker gateway is still unconfined, and building with Claude Code has no OS-level sandbox. See [SECURITY.md](SECURITY.md).
