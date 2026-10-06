# RVR — Research, Validate, Report

Similar idea to my [idd plugin](https://github.com/ambareeshav/idd), rvr (Research, Validate, Report) is for the moment before you commit to a new design. Describe an approach or alternative, and end your message with `rvr`. Claude Code gathers the facts, builds throwaway tests if needed, looks for ways to break the design, and reports back with **Feasibility**, **Why**, **Gotchas**, and a better alternative if there is one. The work happens in separate subagents or a scratch area, so your existing code is never changed.

## Install

Part of [Ambareesha's Claude Code plugins](https://github.com/ambareeshav/claude-plugins). Add the marketplace once, then install rvr from it.

Inside Claude Code:

```
/plugin marketplace add ambareeshav/claude-plugins
/plugin install rvr@ambareeshav
```

Or, once the marketplace is added, run `/plugin`, open the **ambareeshav** marketplace, and install rvr from the list.

If you're continuing a session, run `/reload-plugins` to turn it on.

From the terminal:

```
claude plugin marketplace add ambareeshav/claude-plugins
claude plugin install rvr@ambareeshav
```

## Use

Describe the design decision and end your message with `rvr`, e.g.

> Instead of having the LLM read the whole document with get_document, get_document(code) returns a skeleton and it uses section-ids from the skeleton to read just the needed sections with get_document(code, section_ids=[…]) rvr

The bundled hook forces the skill to run when a message ends with `rvr`. It also triggers on its own when you ask whether a specific design will hold up.
