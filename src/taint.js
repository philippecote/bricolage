/**
 * The lethal trifecta, enforced rather than advised.
 *
 * An action is dangerous when it holds all three of: private data, untrusted
 * content, and the ability to act. The contract has always told agents to split
 * those apart; nothing stopped a generated action from combining them.
 *
 * So the run itself is tracked. The moment an action ingests something a
 * stranger could have written — a fetched page, a web search, a tool result from
 * an outside service — it loses the ability to act on the outside world for the
 * rest of that run. It can still read, and it can still return a proposal for a
 * person to confirm, which is the pattern the contract asks for anyway.
 */
export function createTaintGuard() {
  let source = null;

  return {
    get source() { return source; },
    taint(from) { if (!source) source = from; },

    // Once untrusted text is in the run, a further model call must not be able to
    // reach back out to the web and be steered by what it just read.
    constrainLlm(options = {}) {
      return source ? { ...options, search: false } : options;
    },

    async assertMayCall(host, connectionId, toolName) {
      if (!source) return;
      const connection = await host.get(connectionId);
      await connection.start();
      const tool = connection.tools.find((entry) => entry.name === toolName);
      if (tool?.annotations?.readOnlyHint === true) return;
      const why = tool ? 'is not marked read-only' : 'is unknown';
      throw new Error(
        `This action already read untrusted content (${source}), so it may only use read-only tools from here. "${toolName}" ${why}. `
        + 'Return a proposal the person confirms, and do the write in a separate action.',
      );
    },
  };
}
