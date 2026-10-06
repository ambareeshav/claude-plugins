---
name: rvr
description: Use when the user proposes a specific architectural, schema, pipeline, or technical design decision and asks whether it will actually work, hold up, or be feasible before committing to it. Not for open-ended feature builds or implementation requests.
---

## RVR — Research, Validate, Report

RVR answers "will this work?" for a specific architectural or technical proposal by researching real constraints, then stress-testing the idea from two opposing angles, then reporting a strict, zero-fluff verdict. It is a feasibility check, not an implementation task.

### Gate 1 — Proceed or push back (no subagent, your own judgment)

Before doing anything else, size the request:

- **RVR-worthy**: a bounded yes/no or trade-off question about a specific mechanism ("will this schema hold up under N tenants", "will this retry strategy cause duplicate writes", "should we use X or Y for this pipeline stage").
- **Not RVR-worthy**: a full feature build, a large fix, or anything whose real ask is "implement this" wearing a feasibility-check costume.

If it fails the gate, don't run Research. Push back and propose the narrower feasibility question underneath the ask — e.g. "the real question here seems to be whether X approach holds up; want me to RVR just that part?" Don't silently refuse; always try to hand back a scoped-down version the user can accept.

If it passes, proceed to Research.

### R — Research (always a subagent)

Spawn one subagent whose *only* job is fact-gathering: current docs, library/API constraints, versions, existing code/schema/config relevant to the proposal. Explicitly instruct it NOT to evaluate feasibility or give an opinion — it gathers ground truth only. Bad output looks like "this seems fine because..."; good output looks like "the current schema has constraint X, the library's docs say Y, the relevant code does Z."

**Brief it, don't forward it.** Never hand the subagent the user's raw message. Distill Gate 1's sizing down to the specific mechanism and the 1-3 concrete things that would actually change the verdict, and give it that as the prompt. "Gather everything relevant to X" invites an open-ended sweep of the codebase and docs; "check whether Y library's client supports Z, and whether the current schema at path W already has this constraint" bounds the work to what the verdict depends on. If the bounded brief turns out to be wrong or incomplete once Research reports back, that's fine — send a second, still-bounded follow-up rather than widening the first ask.

### Gate 2 — Sandbox routing (your judgment, `AskUserQuestion` only when needed)

After Research, decide whether Validate needs a live, executable prototype at all:

- **No live run needed** — the mechanism can be reasoned through confidently from Research's findings. Skip straight to Validate, no question asked.
- **Live run needed, self-contained** — a minimal harness that doesn't need the real repo (a standalone function, query, or algorithm). Use the session scratchpad directory. No question asked — this space is already isolated and permission-free.
- **Live run needed, against real repo state** — the prototype must exercise actual project files (real models, real config, real data shapes) to be convincing. This is the only case that requires asking. Use `AskUserQuestion` (structured, not a conversational aside) to offer: scratchpad-only approximation vs. a git worktree against the real repo. Wait for the answer before spawning anything that writes or executes code. Never default to worktree on your own judgment.

### V — Validate

Two roles, run as subagents in parallel *only* when the idea is substantial enough to warrant fresh, isolated context (spans multiple files/systems, has a non-obvious failure mode, or needs actual code execution to be convincing). For a small, well-contained mechanism, reason through both roles yourself inline instead of spawning agents — don't pay subagent overhead for an idea you can trace confidently in your head.

**Sandboxer** — builds the smallest possible harness that proves or disproves the specific mechanism in question (not a production-quality prototype, not a full test suite). If Gate 2 routed to scratchpad or worktree, it runs the harness there and reports the raw, unopinionated result: what happened, pass/fail, error output. If no live run was needed, it produces a step-by-step logic trace instead of code.

**Skeptic** — adversarial by design, not balanced. Its only job is finding reasons this breaks: bottlenecks, security flaws, redundant data fetching, concurrency issues, edge cases. It must surface at least a few candidate concerns before concluding "looks clean" — a Skeptic that rubber-stamps on the first pass isn't doing its job. If Sandboxer produced real run output, brief Skeptic with it — a concrete result gives sharper things to poke at than pure theory ("here's what happened when it ran — what does this NOT cover?").

### Report — Synthesizer (you, not a subagent)

You already hold the full context (the original idea, the Gate 1 reasoning, Research's findings, and both Validate outputs) — spinning up a fourth subagent here would just re-derive what you already know. Synthesize directly. Strict format, no wall of text:

- **Feasibility Score** — Highly Feasible / Feasible with Trade-offs / Will Break.
- **The Why** — the core reason it works or fails, one to a few sentences.
- **The Gotchas** — the concrete issues Skeptic actually surfaced, not generic caveats.
- **The Pivot** — only if not Highly Feasible: a specific, better alternative approach.
