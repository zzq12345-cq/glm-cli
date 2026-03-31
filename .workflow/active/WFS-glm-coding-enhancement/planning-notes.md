# Planning Notes

## User Intent

GOAL: Turn this Claude Code source snapshot into a pure GLM-based coding CLI.

SCOPE: Keep the current Claude Code interaction style mostly unchanged, but improve coding quality through better context gathering, safer tool orchestration, lightweight planning, and verification before completion.

CONTEXT:
- The workspace is a source snapshot, not a git worktree.
- The approved design spec is at `docs/superpowers/specs/2026-03-31-glm-coding-enhancement-design.md`.
- Phase 1 is locked to an OpenAI-compatible GLM API surface.
- Phase 1 task classification must be heuristic, not LLM-driven.
- Phase 1 needs a dedicated project-detection module for test/typecheck/lint/build discovery.

## Key Review Outcomes

- Treat `src/services/api/claude.ts` as a seam-carving problem and do a split analysis before extraction.
- Lock the GLM transport choice early to avoid adapter churn.
- Keep internal message structures stable in the first implementation slice.
- Add a latency budget for context gathering and bounded repair loops.
- Use a golden-path E2E scenario as a hard phase-1 acceptance gate.

## High-Risk Areas

- `src/services/api/claude.ts`
- `src/utils/messages.ts`
- `src/services/tokenEstimation.ts`
- `src/utils/tokens.ts`
- tool-call streaming normalization
- capability assumptions tied to Claude model names

## Planning Strategy

- Complete Phase 0 first: seam analysis, adapter interface, token-estimation migration plan, project-detection design.
- Keep Phase 1 narrow: provider switch, GLM adapter, safe degradation, one golden-path workflow.
- Delay broad prompt tuning and advanced classification until Phase 2 or Phase 3.
