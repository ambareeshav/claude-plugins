# IDD — Ideate, Debate, Discuss

idd puts Claude Code into talk-only mode for a single message. End your message with `idd` and Claude will ideate, debate trade-offs, and plan with you, but it won't write code, edit files, or run commands that change your code.

Use it when you want to think an idea through before anything gets built. To check whether a specific design will actually hold up, see [rvr](https://github.com/ambareeshav/rvr).

## Install

Part of [Ambareesha's Claude Code plugins](https://github.com/ambareeshav/claude-plugins). Add the marketplace once, then install idd from it.

Inside Claude Code:

```
/plugin marketplace add ambareeshav/claude-plugins
/plugin install idd@ambareeshav
```

Or, once the marketplace is added, run `/plugin`, open the **ambareeshav** marketplace, and install idd from the list.

If you're continuing a session, run `/reload-plugins` to turn it on.

From the terminal:

```
claude plugin marketplace add ambareeshav/claude-plugins
claude plugin install idd@ambareeshav
```

## Use

End your message with `idd`, e.g.

> Should uploads go straight to blob storage, or through the API first so we can validate them? idd

Only messages that end with `idd` are affected. Your next message without it goes back to normal.
