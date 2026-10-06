#!/usr/bin/env python3
import sys, json, re

data = json.load(sys.stdin)
prompt = data.get("prompt", "").strip()

if re.search(r"\brvr\.?$", prompt, re.IGNORECASE):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": (
                "RVR MODE ACTIVE: The user wants a Research-Validate-Report feasibility "
                "check on the proposal in this message. Invoke the 'rvr' skill now via the "
                "Skill tool and follow it exactly — do not free-associate a feasibility "
                "opinion, and do not treat this as a request to implement the idea."
            )
        }
    }))
