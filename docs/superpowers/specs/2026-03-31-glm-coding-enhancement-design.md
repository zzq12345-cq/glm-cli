# GLM Coding Enhancement Design

Date: 2026-03-31
Status: Approved in conversation, design only
Scope: Pure GLM backend, keep Claude Code interaction mostly unchanged, apply mild coding-focused enhancements

## 1. Summary

This design converts the current Claude Code source snapshot into a pure GLM-powered coding CLI while preserving the existing interaction model as much as possible. The goal is not only to "make GLM work" as a backend, but to make it perform better on software engineering tasks through better context gathering, safer tool orchestration, a lightweight planning step for multi-file work, and a verification-and-repair loop before task completion.

The first version should not attempt a full product rebrand or a full removal of all Anthropic-specific assumptions. Instead, it should introduce a GLM provider adapter, a provider-aware capability layer, and a coding-strengthening layer that improves engineering outcomes without forcing users into a visibly different workflow.

## 2. Goals

### Primary goals

- Replace the effective model backend with GLM only.
- Preserve the existing Claude Code style interaction for end users.
- Improve coding task quality for:
  - small and medium file edits
  - large repository understanding
  - multi-file refactors
  - test-driven bug fixing
- Prefer evidence-based behavior over intuition:
  - read code before editing
  - search for existing patterns before proposing new ones
  - verify changes before declaring completion
- Introduce mild internal workflow changes only when they improve coding quality.

### Non-goals for the first version

- Full removal of all Anthropic-specific naming and branding.
- A full rewrite of the UI layer.
- Major changes to MCP, bridge, remote, voice, analytics, or team-memory systems.
- Multi-model routing or fallback to non-GLM models.
- A deep protocol abstraction that redesigns every message type in the application.

## 3. Product constraints

- Backend must be pure GLM. No mixed routing.
- User-visible workflow should remain close to current Claude Code behavior.
- Mild internal enhancements are allowed if they improve coding quality.
- Unsupported Claude-specific features must degrade safely instead of breaking the query loop.
- The system should optimize for coding reliability, not just raw output generation.

### Locked phase-1 design decisions

- Phase 1 will target a GLM endpoint with an OpenAI-compatible API surface.
- Native GLM protocol integration is explicitly out of scope for phase 1 unless the OpenAI-compatible path proves to block required tool-calling behavior.
- Task classification in phase 1 will be heuristic and rule-based, not LLM-driven.
- Verification command selection in phase 1 will depend on a dedicated project-detection module.
- Context gathering will run under a bounded latency budget instead of unbounded exploration.

## 4. Current codebase observations

The current source snapshot is strongly centered around Anthropic message types and provider assumptions.

### Main integration points

- `src/services/api/client.ts`
  - Builds provider-specific Anthropic SDK clients.
- `src/services/api/claude.ts`
  - Constructs request payloads, calls `beta.messages.create`, interprets streaming events, and normalizes API output.
- `src/utils/model/providers.ts`
  - Selects the active provider.
- `src/utils/model/model.ts`
  - Resolves the active model and provider-specific model names.
- `src/utils/model/modelOptions.ts`
  - Drives model picker options and descriptions.
- `src/utils/model/modelStrings.ts`
  - Maps canonical model IDs to provider-specific strings.
- `src/utils/thinking.ts`
  - Encodes thinking/adaptive thinking support assumptions.
- `src/utils/messages.ts`
  - Contains Anthropic block normalization and message conversions.
- `src/query.ts`
  - Runs the main query loop, tool continuation, and recovery logic.
- `src/query/config.ts`
  - Builds per-query configuration gates.
- `src/constants/prompts.ts`
  - Builds the main system prompt.
- `src/utils/systemPrompt.ts`
  - Chooses the effective system prompt.
- `src/services/tools/toolOrchestration.ts`
  - Batches tool calls and controls safe concurrency.
- `src/services/tools/toolExecution.ts`
  - Executes tool calls and feeds results back into the loop.

### Structural conclusion

The current application already has the idea of "multiple providers", but those providers still assume Anthropic APIs, Anthropic message blocks, and Claude model capabilities. This means changing the backend is not just a base URL swap. The main work is to separate:

- model transport and protocol mapping
- provider capability detection
- coding task strategy

from the current Anthropic-specific implementation.

### `claude.ts` seam-analysis prerequisite

`src/services/api/claude.ts` is a very large file and should be treated as a seam-carving problem, not a casual extraction task.

Before phase-1 implementation begins, perform a split analysis that tags the major functions and code blocks into these buckets:

- transport and protocol translation
- request shaping and capability logic
- orchestration and retry behavior
- telemetry and logging
- provider-specific edge handling

Expected output of the split analysis:

- a map of extraction candidates
- a list of provider-independent helpers that can move first
- a list of risky functions that must remain in place temporarily
- explicit boundaries for what will live in the provider adapter versus the outer orchestration layer

This analysis is a required phase-0 deliverable.

## 5. Proposed architecture

The implementation should be split into four layers.

### Layer A: GLM provider adapter

Purpose:
- route the internal request pipeline to GLM
- map internal message structures into GLM request format
- normalize GLM responses back into the existing internal message format

Responsibilities:
- request construction
- streaming event conversion
- tool-call parsing
- error normalization
- model name translation

Key principle:
- do not spread `if provider === "glm"` checks across the whole codebase
- instead, isolate transport and protocol mapping in a dedicated adapter layer

### Layer B: capability compatibility layer

Purpose:
- make features conditional on provider capabilities instead of assuming Claude behavior

Capabilities to model explicitly:
- thinking support
- adaptive thinking support
- effort support
- structured output support
- tool-calling support
- streaming tool delta support
- large-context support

Key principle:
- unsupported features must be disabled or degraded in a controlled way
- the rest of the app should ask "is this supported?" rather than assume support

### Layer C: coding-strengthening layer

Purpose:
- improve GLM coding performance without visibly changing the product workflow

Main strategies:
- stronger default context gathering
- lightweight planning for multi-file work
- verification ladder after code edits
- bounded fix loop after failed verification

### Layer D: prompt and policy tuning layer

Purpose:
- teach GLM to behave like a reliable coding agent in this CLI

Main strategies:
- strengthen repository-reading discipline
- strengthen pattern matching with existing code
- discourage speculative abstractions
- require explicit verification before completion
- encourage local diagnosis before asking the user

## 6. Detailed design

### 6.1 Provider integration model

Add `glm` as a first-class provider in the provider selection layer.

Target changes:
- extend `APIProvider` in `src/utils/model/providers.ts`
- add GLM-specific environment and config detection
- create a GLM client factory parallel to current Anthropic client construction

Preferred design:
- extract provider-independent request orchestration from `src/services/api/claude.ts`
- keep the outer query contract stable
- move provider-specific request and stream translation into adapter modules

Phase-1 protocol decision:
- use an OpenAI-compatible GLM interface as the adapter target
- do not implement a native GLM protocol adapter in phase 1

Rationale:
- lower adapter complexity
- simpler SDK and mock strategy
- lower streaming parser risk
- faster path to a usable coding-focused build

Recommended module shape:

- `src/services/api/providers/base.ts`
  - shared provider interfaces
- `src/services/api/providers/anthropicAdapter.ts`
  - extracted from current logic
- `src/services/api/providers/glmAdapter.ts`
  - new GLM implementation

Recommended phase-1 file list:

- `src/services/api/providers/base.ts`
- `src/services/api/providers/glmAdapter.ts`
- `src/services/api/providers/anthropicAdapter.ts`
- `src/services/api/providers/providerRegistry.ts`
- `src/services/api/providers/types.ts`

The main loop should interact with a provider adapter interface instead of directly calling Anthropic SDK methods.

Example responsibilities for the adapter interface:
- create request from normalized messages
- stream assistant output
- emit normalized text blocks
- emit normalized tool_use blocks
- return normalized usage data
- normalize provider errors

Illustrative interface shape:

```ts
export interface ProviderAdapter {
  readonly provider: APIProvider

  supports(capability: ProviderCapability): boolean

  buildRequest(input: NormalizedProviderRequest): ProviderRequest

  streamResponse(
    request: ProviderRequest,
    options: ProviderRequestOptions,
  ): AsyncGenerator<NormalizedProviderEvent, ProviderFinalResult>

  normalizeError(error: unknown): NormalizedProviderError

  estimateTokens?(
    input: NormalizedProviderRequest,
  ): Promise<ProviderTokenEstimate | null>
}
```

Phase-1 implementation note:
- the adapter should accept injected `fetch` or transport dependencies so it can be tested in CI without live GLM access
- streaming parsing should be fixture-driven in tests, using recorded chunk sequences rather than only snapshotting final responses

### 6.2 Internal message strategy

The first version should keep the existing internal message structure and UI-facing message flow.

Rationale:
- `src/utils/messages.ts`
- `src/query.ts`
- tool execution flow
- message rendering components

already depend on the current internal block model. Rewriting that structure in phase 1 would add large regression risk.

Therefore:
- GLM output should be converted into the existing internal assistant content format
- GLM tool calls should be normalized into the existing `tool_use` block shape
- GLM textual output should become existing text blocks
- unsupported block types should be ignored or mapped to plain text if safe

First-version rule:
- keep the inside of the app stable
- adapt the boundary, not the whole app

### 6.3 Capability compatibility layer

Current capability logic is tightly tied to Claude naming and provider assumptions.

Files most affected:
- `src/utils/thinking.ts`
- `src/utils/model/model.ts`
- `src/utils/model/modelOptions.ts`
- `src/utils/model/modelStrings.ts`

Design:
- move capability decisions behind provider-aware feature checks
- avoid deriving capability purely from Claude model name patterns
- use explicit GLM capability metadata where possible

Minimum capability matrix for phase 1:

- `supportsToolCalling`
- `supportsStreamingText`
- `supportsStreamingToolCalls`
- `supportsThinking`
- `supportsAdaptiveThinking`
- `supportsEffort`
- `supportsStructuredOutputs`
- `supportsLongContext`

Behavioral rules:
- if GLM does not support `thinking`, disable thinking-related prompt and UI assumptions
- if GLM does not support `effort`, suppress effort-dependent request shaping
- if GLM does not support structured outputs reliably, avoid strict JSON-dependent flows unless guarded
- if GLM tool calls are unstable, force stricter parsing and reject malformed calls before they reach tool execution

### 6.4 Model configuration and selection

The current model system is Claude-family-centric. The first version should not try to build a generalized model catalog for every GLM variant, but it should make model selection coherent.

Target behavior:
- select a default GLM coding model
- optionally allow explicit GLM model string override from config or env
- show model picker labels that remain understandable even if not fully rebranded

Recommended approach:
- define one default coding-focused GLM model
- support explicit overrides through env/settings
- keep existing picker UI but simplify the option set under the GLM provider

First-version recommendation:
- expose a small set of GLM model options at most
- prefer stable defaults over a wide menu

### 6.5 Coding-strengthening layer

This layer is the main source of quality improvement.

#### A. Task classification

Before building the final provider request, classify the user task into one of the following broad categories:

- explanation / read-only understanding
- targeted small edit
- multi-file change
- bug fix from error output
- repo-wide investigation

This classification should be lightweight and internal. It should not introduce a new visible mode switch.

Phase-1 classifier design:
- use deterministic heuristics only
- do not ask GLM to classify its own task type

Initial heuristics should look at:
- whether the prompt mentions concrete file paths
- whether the prompt requests a modification versus an explanation
- whether there are error traces or test failures in the input
- whether there are multi-file indicators such as "refactor", "across", "all", or named modules
- whether the user is asking for read-only understanding

LLM-assisted fine-grained classification is deferred to phase 3.

#### B. Project detection

Verification command discovery should be handled by a dedicated project-detection module instead of ad hoc guessing.

Recommended module:
- `src/query/projectDetection.ts`

Phase-1 responsibilities:
- inspect common project manifests and config files
- discover likely commands for:
  - test
  - typecheck
  - lint
  - build
- rank candidate commands by confidence
- cache results for the current session or repository

Initial detection sources:
- `package.json`
- `bunfig.toml`
- `Makefile`
- `pyproject.toml`
- `pytest.ini`
- `Cargo.toml`
- `go.mod`
- repository-local docs such as `AGENTS.md` or equivalent instruction files

The verification ladder should consume this module rather than scanning the repo from scratch every time.

#### C. Stronger context gathering

For coding tasks:
- always read the target file before proposing edits
- if the task touches an existing pattern, retrieve at least three similar implementations when available
- for repository-level questions, gather:
  - likely entrypoints
  - adjacent config files
  - neighboring type definitions
  - likely call sites

This is especially important for GLM because coding failure often comes from incomplete or imprecise context, not from inability to write syntax.

#### D. Lightweight short plan

For multi-file edits and refactors:
- generate a short internal plan before editing

The plan should capture:
- files to inspect
- files to edit
- order of changes
- verification command(s)

This is not the same as a heavy explicit plan-mode flow. It is an internal stabilizer used only when needed.

#### E. Verification ladder

After code edits, verify using the narrowest useful scope:

1. targeted test if obvious
2. related test suite if targeted test is not obvious
3. typecheck if tests are absent
4. lint if lint is the best available signal
5. build or command-level validation if needed

If none of the above are discoverable:
- report that no automated verification was found
- avoid claiming success beyond the code change itself

Verification command selection rules:
- prefer commands returned by the project-detection module
- if multiple candidates exist, choose the narrowest command whose inputs overlap the edited surface
- avoid broad project-wide build or lint steps unless no narrower signal exists

#### F. Bounded repair loop

If verification fails:
- parse the failure
- apply a focused repair
- rerun the same verification
- stop after a small bounded number of attempts

Recommended first-version limit:
- 2 repair rounds after the initial failure

This improves end-to-end task completion without creating unbounded loops.

### 6.6 Prompt and policy tuning

The default prompt should be tuned for GLM coding behavior while staying close to the existing Claude Code interaction style.

Add or strengthen instructions in `src/constants/prompts.ts`:

- do not suggest code changes before reading the file
- for multi-file tasks, identify the change surface before editing
- prefer matching existing patterns over creating fresh abstractions
- after edits, verify before declaring completion
- if uncertain, search or read more context rather than guessing
- if a command or test fails, diagnose the failure before switching strategy
- report verification honestly

Important constraint:
- keep the tone and outer workflow familiar
- do not turn every request into a visible formal planning workflow

### 6.7 Query loop integration

The main query loop in `src/query.ts` should remain the orchestrator.

Recommended integration points:

- before request build:
  - classify task
  - gather context
  - optionally build short plan
- before completion:
  - decide whether verification is required
- after failed verification:
  - run bounded repair loop

This should be implemented as query-stage hooks or helper modules, not as ad hoc logic scattered across the loop.

Suggested helper modules:

- `src/query/taskClassification.ts`
- `src/query/projectDetection.ts`
- `src/query/contextGathering.ts`
- `src/query/verificationPolicy.ts`
- `src/query/fixLoop.ts`

### 6.8 Tool orchestration strategy

The current tool orchestration already has useful concurrency rules. This should be preserved and mildly improved for GLM.

Target behaviors:
- read-only discovery calls may run concurrently
- write-affecting tools should remain conservative and usually serial
- search before edit should be encouraged for complex tasks
- verification commands should be automatically selected when edits occur

Potential mild enhancements:
- bias toward a read-search-read sequence before the first edit in complex tasks
- discourage tool thrashing by grouping context reads before edits
- detect when the model is attempting to edit with too little context and inject a corrective reminder

### 6.9 Error handling and degradation

The first version must degrade safely when GLM does not match Claude features.

#### Unsupported features

- thinking not supported:
  - disable thinking request parameters
  - ignore thinking-only rendering assumptions
- effort not supported:
  - remove effort-specific request shaping
- tool delta support incomplete:
  - accept only stable tool call forms
  - fall back to non-incremental parsing if needed

#### Malformed tool calls

If GLM emits invalid tool-call payloads:
- reject them before tool execution
- return a normalized assistant-side error or retry prompt
- do not let malformed payloads crash the main loop

#### Provider transport failures

Normalize:
- auth errors
- rate limits
- timeouts
- invalid request payloads
- malformed streamed chunks

The rest of the app should receive normalized errors instead of provider-specific raw failure shapes.

### 6.10 Configuration and environment model

The first version should keep configuration simple.

Recommended new configuration surface:

- `GLM_API_KEY`
- `GLM_BASE_URL` if needed
- `GLM_MODEL`
- `GLM_SMALL_FAST_MODEL` if a fast model split is needed later

Potential provider selection behavior:
- either explicit `CLAUDE_CODE_USE_GLM=1`
- or a more general provider variable if the provider system is cleaned up

Keep first-version config small and predictable.

### 6.11 Token estimation and tokenizer strategy

Token estimation is a migration risk because parts of the current code assume Anthropic SDK behavior and Anthropic-style usage accounting.

Phase-1 strategy:
- make token estimation provider-pluggable
- do not block execution on exact GLM tokenization support
- prefer conservative estimates over precision when precise tokenizer support is unavailable

Recommended design:
- add a provider-level token estimator interface
- if the OpenAI-compatible GLM endpoint returns authoritative usage, record and prefer that post-response data
- for preflight budgeting, use a conservative approximation derived from serialized message size and provider-specific calibration factors
- preserve existing hard safety limits even if only approximate estimation is available

Implementation guidance:
- treat `src/services/tokenEstimation.ts` and `src/utils/tokens.ts` as risk points during provider extraction
- keep the estimator optional so the query path still works when only coarse estimation exists

### 6.12 Performance and latency budget

The coding-strengthening layer must not introduce unbounded latency.

Phase-1 budgets:
- pre-edit context gathering soft budget: 3000 ms
- pre-edit context gathering hard cap: 5000 ms
- maximum automatic repair rounds after verification failure: 2
- verification should only run automatically for edit-producing tasks, not read-only queries

Performance targets relative to the current baseline:
- coding-task p50 latency increase target: no more than 25 percent
- coding-task p95 latency increase target: no more than 40 percent

Fallback behavior:
- if context gathering exceeds budget, stop additional discovery and continue with the best available context
- if project detection is slow or ambiguous, prefer the narrowest high-confidence verification command or skip verification with explicit reporting
- do not allow validation loops to grow without bound

## 7. End-to-end data flow

The desired request flow is:

1. User input enters `query()`
2. Internal task classification runs
3. Context gathering runs when the task is coding-oriented
4. Effective system prompt is built, including GLM coding-strengthening instructions
5. Normalized conversation state is passed to the GLM adapter
6. Adapter constructs a GLM request
7. GLM response stream is converted into normalized internal message blocks
8. Tool calls are routed through existing tool execution and orchestration
9. Tool results are injected back into the query loop
10. Before final completion, verification policy decides whether checks must run
11. If checks fail, bounded repair loop runs
12. Final result is reported in the usual CLI interaction style

## 8. Testing strategy

The source snapshot does not expose a clear, full existing test suite structure, so the GLM migration should add targeted tests for the highest-risk paths.

### Required test categories

#### Adapter tests

- normalized messages to GLM request conversion
- GLM streamed output to normalized blocks conversion
- tool-call parsing success and failure
- provider error normalization
- fixture-based streaming parser tests using injected transport mocks instead of live API calls

#### Capability tests

- GLM capability matrix
- disabled thinking behavior
- disabled effort behavior
- structured output downgrade behavior

#### Prompt strategy tests

- coding tasks inject stronger context and verification instructions
- non-coding tasks do not trigger heavy coding flow

#### Query integration tests

- small edit workflow
- multi-file workflow with short plan
- tool call workflow
- failed verification followed by bounded repair

#### Golden-path phase-1 acceptance test

Define one mandatory end-to-end acceptance scenario for phase 1:

1. user asks to change a function in one existing source file
2. system classifies the task as a targeted small edit
3. system reads the file before proposing the edit
4. GLM emits a normalized edit tool call
5. tool execution applies the change
6. project detection chooses a related verification command
7. verification succeeds
8. final response reports the code change and the verification result honestly

This golden path should pass before any broader phase-1 completion claim.

#### Mock strategy

- adapter tests should use injected `fetch` or transport shims
- streamed responses should be tested with recorded chunk fixtures
- no CI test should require live GLM credentials
- query integration tests should stub provider output and tool results independently so failures are easy to localize

#### Regression tests

- existing internal message rendering still works with normalized GLM output
- tool execution contract remains stable
- completion reporting remains honest when verification is skipped or fails

## 9. Implementation phases

### Phase 0: Preparation and seam definition

Deliverables:
- `claude.ts` split analysis
- locked protocol decision: OpenAI-compatible GLM interface for phase 1
- provider adapter interface definition
- initial project-detection design
- token-estimation migration plan

Success criteria:
- extraction boundaries are documented
- phase-1 implementation no longer depends on unresolved protocol questions
- the team has a clear list of which code moves first and which code stays in place temporarily

### Phase 1: Make GLM work safely

Deliverables:
- GLM provider selection
- GLM adapter
- stable text response path
- stable tool-call path
- safe feature degradation
- golden-path end-to-end scenario

Success criteria:
- basic coding conversations work
- basic tool use works
- unsupported Claude-only capabilities do not break execution

### Phase 2: Add coding-strengthening behavior

Deliverables:
- task classification
- stronger context gathering
- short-plan support for multi-file edits
- verification ladder
- bounded repair loop

Success criteria:
- improved performance on code explanation, file edits, refactors, and bug fixes
- reduced incomplete edits and reduced "done without verification" behavior

### Phase 3: Tune quality and polish

Deliverables:
- prompt tuning based on observed failure patterns
- better malformed tool-call recovery
- better verification command selection
- model option and capability cleanup

Success criteria:
- more stable end-to-end coding quality
- fewer provider-specific edge failures
- improved consistency across repository sizes and task types

## 10. Risks

- Anthropic assumptions are deeper than the provider switch alone, especially in message typing and streaming.
- GLM tool-calling behavior may not match current Anthropic flow exactly.
- Capability mismatches may surface in subtle places such as UI hints, effort controls, or token estimation.
- Automatic verification can be noisy if command detection is too aggressive.
- Query-loop changes can cause regressions if context gathering and repair logic are injected in an ad hoc way.

## 11. Mitigations

- keep internal message format stable in phase 1
- isolate adapter logic instead of spreading provider checks
- introduce explicit capability checks
- use bounded repair loops
- keep verification narrow and local
- write targeted tests for the adapter and query integration points

## 12. Open questions for implementation

- Which GLM model should be the default coding model?
- Should fast-mode behavior be preserved, disabled, or remapped under GLM in phase 1?
- Which existing token estimation paths depend too directly on Anthropic SDK behavior?
- Does the selected OpenAI-compatible GLM endpoint provide sufficiently stable streamed tool calls, or should phase 1 normalize only final tool-call frames?

## 13. Recommended first implementation slice

Start with the smallest slice that proves the architecture:

1. complete phase-0 seam analysis and lock the OpenAI-compatible endpoint
2. add `glm` provider selection
3. create a GLM adapter that supports:
   - text responses
   - normalized tool calls
   - normalized usage and errors
4. keep internal messages unchanged
5. disable unsupported thinking and effort behavior
6. add one coding-strengthening path:
   - stronger pre-edit context gathering
   - post-edit verification ladder
7. pass the golden-path end-to-end scenario

This will produce a usable first version while leaving room for later refinement.

## 14. Acceptance criteria for the design

This design is successful if the first implementation can:

- run the CLI with GLM as the only model backend
- preserve the familiar Claude Code interaction style
- safely execute code-oriented tool flows
- improve coding reliability through better context gathering and verification
- degrade unsupported Claude-specific capabilities without breaking the user experience
- keep context gathering and validation within the defined latency budget
- pass the phase-1 golden-path acceptance test
