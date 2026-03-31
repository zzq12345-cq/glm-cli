# Implementation Plan

## Objective

Implement a pure GLM backend for this Claude Code source snapshot while preserving the familiar CLI interaction style and improving coding reliability through:

- stronger context gathering
- provider-aware capability handling
- lightweight pre-edit planning for complex tasks
- automatic post-edit verification
- a bounded repair loop when verification fails

## Planning assumptions

- Phase 1 uses an OpenAI-compatible GLM API surface.
- Native GLM protocol support is deferred.
- The existing internal message model remains the compatibility target in Phase 1.
- `src/services/api/claude.ts` must be split carefully, not rewritten in one pass.
- This repository currently has no visible `.git` metadata, so the plan assumes a snapshot-based workflow.

## Delivery strategy

### Phase 0

Purpose: define safe seams before changing runtime behavior.

Outputs:
- seam analysis for `src/services/api/claude.ts`
- provider adapter interface
- provider registry plan
- token-estimation migration plan
- project-detection design

### Phase 1

Purpose: make GLM work safely on the narrowest useful path.

Outputs:
- `glm` provider selection
- OpenAI-compatible GLM adapter
- stable text and tool-call normalization path
- safe capability degradation
- golden-path end-to-end scenario

### Phase 2

Purpose: improve end-to-end coding behavior.

Outputs:
- heuristic task classification
- stronger context gathering
- verification ladder
- bounded repair loop
- prompt and policy updates for coding reliability

## Workstreams

### Workstream A: Provider and transport extraction

Tasks:
- IMPL-1
- IMPL-2
- IMPL-3

Outcome:
- the query layer stops depending directly on Anthropic transport details

### Workstream B: Capability and model safety

Tasks:
- IMPL-4

Outcome:
- GLM can run with predictable feature degradation

### Workstream C: Coding-strengthening workflow

Tasks:
- IMPL-5
- IMPL-6

Outcome:
- coding tasks get better context and better completion discipline

### Workstream D: Test and acceptance coverage

Tasks:
- IMPL-7

Outcome:
- golden-path verification and CI-friendly mocks exist before broad rollout

## Task breakdown

### IMPL-1: Seam analysis for `claude.ts`

Goal:
- map `src/services/api/claude.ts` into extraction-ready responsibility buckets

Scope:
- identify transport logic
- identify provider-independent orchestration logic
- identify capability-specific shaping
- identify logging and telemetry side paths
- produce a written seam map in `.workflow/active/WFS-glm-coding-enhancement/.process/`

Why first:
- every later extraction depends on clean boundaries here

Done when:
- the extraction order is documented
- high-risk functions are listed
- the adapter boundary is explicit

### IMPL-2: Create provider base layer and registry

Goal:
- introduce the adapter abstraction without changing user-visible behavior

Scope:
- add provider adapter interfaces
- add provider capability types
- add a provider registry or selector
- preserve existing Anthropic behavior behind an adapter

Likely files:
- `src/services/api/providers/base.ts`
- `src/services/api/providers/types.ts`
- `src/services/api/providers/providerRegistry.ts`
- `src/utils/model/providers.ts`

Done when:
- the app can resolve a provider adapter through a stable interface
- Anthropic behavior still works through the adapter boundary

### IMPL-3: Implement OpenAI-compatible GLM adapter

Goal:
- support a narrow but stable GLM request/response path

Scope:
- build requests from normalized messages
- normalize text output
- normalize tool calls
- normalize errors and usage
- support mockable streaming transport

Likely files:
- `src/services/api/providers/glmAdapter.ts`
- `src/services/api/client.ts`
- `src/services/api/claude.ts`

Done when:
- the adapter can power the golden-path flow with injected mocks
- malformed tool calls and provider errors degrade safely

### IMPL-4: Refactor capability, model, and token-estimation handling

Goal:
- remove the most dangerous Claude-only assumptions from runtime decision-making

Scope:
- add provider-aware capability checks
- simplify GLM model selection
- disable unsupported thinking and effort behavior
- make token estimation provider-pluggable

Likely files:
- `src/utils/model/model.ts`
- `src/utils/model/modelOptions.ts`
- `src/utils/model/modelStrings.ts`
- `src/utils/thinking.ts`
- `src/services/tokenEstimation.ts`
- `src/utils/tokens.ts`

Done when:
- GLM no longer depends on Claude-family name matching for core capability checks
- token estimation no longer blocks the GLM path

### IMPL-5: Add heuristic task classification and project detection

Goal:
- improve context gathering and verification command selection without LLM self-classification

Scope:
- classify read-only vs edit vs multi-file vs bug-fix tasks using rules
- detect test, typecheck, lint, and build commands from project manifests
- cache detection results per session or repository

Likely files:
- `src/query/taskClassification.ts`
- `src/query/projectDetection.ts`
- `src/query/config.ts`

Done when:
- edit-producing tasks can be classified deterministically
- verification policy can consume project-detection output

### IMPL-6: Add context gathering, verification ladder, and bounded repair loop

Goal:
- improve coding reliability after the provider switch

Scope:
- inject stronger pre-edit context gathering
- add lightweight short plans for complex changes
- run narrow verification after edits
- retry with at most two repair rounds
- update system prompt guidance to support this flow

Likely files:
- `src/query.ts`
- `src/query/contextGathering.ts`
- `src/query/verificationPolicy.ts`
- `src/query/fixLoop.ts`
- `src/constants/prompts.ts`
- `src/utils/systemPrompt.ts`

Done when:
- edit tasks default to better context and explicit verification
- failed verification can trigger a bounded repair cycle

### IMPL-7: Build test harness, mocks, and golden-path acceptance coverage

Goal:
- make the new path verifiable in CI without live GLM access

Scope:
- add injected transport mocks for adapter tests
- add fixture-driven streaming parser tests
- add query integration coverage for the golden path
- add latency-budget assertions where practical

Done when:
- the golden-path scenario passes
- provider tests do not require live credentials

## Dependency order

1. IMPL-1
2. IMPL-2
3. IMPL-3
4. IMPL-4
5. IMPL-5
6. IMPL-6
7. IMPL-7

## Recommended stopping points

- Stop after IMPL-1 for design sanity review.
- Stop after IMPL-3 for a provider integration review.
- Stop after IMPL-6 for a behavior-quality review before broad cleanup.

## Risks to watch during implementation

- accidental leakage of Anthropic block assumptions into the GLM path
- over-extraction from `claude.ts` causing regression churn
- verification-command misfires on heterogeneous repositories
- tool-call normalization drift between mocked and real streaming behavior
- latency growth from overly aggressive context gathering

## Acceptance gates

The plan is considered successful when:

- Phase 0 artifacts exist and are actionable
- the golden-path scenario works on the GLM path
- unsupported Claude-specific features degrade safely
- context gathering and verification stay within the declared latency budget
