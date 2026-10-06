#!/usr/bin/env python3
import sys, json, re

data = json.load(sys.stdin)
prompt = data.get("prompt", "").strip()

if re.search(r"\bidd\.?$", prompt, re.IGNORECASE):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": (
                "IDD MODE ACTIVE: The user wants to Ideate, Debate and Discuss only. "
                "You MUST NOT write any code, edit files, or run commands that change code. "
                "Do not use Write, Edit, or Bash tools for code changes. "
                "Only discuss, ideate, debate and plan. "
                "Explore tradeoffs, approaches, and designs conversationally."
            )
        }
    }))
