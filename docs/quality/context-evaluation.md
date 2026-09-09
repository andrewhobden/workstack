# Project context evaluation

The checked-in corpus in `tests/fixtures/context-evaluation/corpus.v1.json` defines nine synthetic tasks and their expected source keys and mandatory context categories. It includes exact identifiers, abbreviations, paraphrases, a deep passage after 400 paragraphs, superseded decisions, interrupted work, unavailable evidence, project isolation, and 768 additional catalog documents. The complete fixture contains 778 sources and 1,178 passages.

**Human review is pending.** The expected evidence was authored separately from ranking code, but no maintainer has yet certified it. The `review` object records that limitation. Do not describe this dataset or its scores as human-reviewed, or as proof of real-world agent task quality. A maintainer should inspect each task and its expected evidence, record their identity and rationale, and create a new corpus revision when changing expectations. Agent reports are candidates for this process, not accepted facts.

## Maintainer review queue

All nine cases below remain **pending human review**. Source keys refer to the checked-in corpus. Every case requires `task` and `repository` context; additional mandatory categories are listed below. The reviewer should confirm that the expected evidence supports the task and identify any missing evidence before accepting the case.

| Case and task intent | Expected evidence or gap | What the maintainer must confirm |
| --- | --- | --- |
| `exact-identifier`: validate `resumeClaimLease` ownership before retry | Retrieve `queue-api`; also require `purpose` and `conventions` context. | The cited API passage states ownership validation and rejection of expired tokens; the purpose and engineering rules are relevant prerequisites. |
| `acronym`: explain QS retry ownership | Retrieve `architecture`; require `architecture` context. | QS unambiguously refers to QueueService, and the passage explains durable queue ownership and publication under a current claim. |
| `paraphrase`: resume work after the application restarts | Expected source: `recovery`; require `architecture` context. `mustRetrieve` is empty, so this source is scored but not required in the ranked top 10. | The restart query is answered by persisted-claim reconciliation and saved checkpoints; decide whether the current nonblocking retrieval expectation is sufficient. Lexical overlap does not establish semantic understanding. |
| `deep-evidence`: implement `recoverFencedOwnership` from the appendix | Retrieve `long-document`, with its relevant passage after 400 generated paragraphs; require `architecture` context. | The exact deep passage requires a new claim token and checkpoint validation; its citation reaches that passage rather than an unrelated document preview. |
| `current-over-history`: update RetryQueue using the accepted decision | Retrieve `current-design`; exclude `old-design`; require `decisions` context. | The persisted SQLite/fenced-ownership decision is the governing guidance, and the superseded in-memory design cannot be presented as current. |
| `interrupted-work`: continue interrupted queue recovery | Retrieve `recovery` and include the saved checkpoint; require `checkpoint` context. | The checkpoint and recovery protocol provide enough prior progress and next-action context to resume without repeating completed work. |
| `offline-mandatory-source`: execute operations maintenance | Exclude unavailable `offline` evidence; require `purpose`, report it missing, and block execution. | The pinned operations policy is mandatory, its unavailable content cannot be treated as verified, and an explicit gap with blocked execution is the correct outcome. |
| `large-corpus`: repair `RareSchedulerKey_733` dispatch | Retrieve `large-target` among the additional 768 catalog documents; require `code` context. | The rare-identifier passage identifies the immutable-envelope behavior relevant to duplicate dispatch; synthetic distractors are adequate for this narrow retrieval check. |
| `project-isolation`: look for `ForeignProjectSentinel_8842` in the current project | No expected source; exclude `foreign-only`. No additional mandatory category or expected category gap. | Evidence belonging only to the other project never appears; an empty result makes no claim about whether the current project has complete documentation. |

This table is a review aid, not an approval record. Keep `review.status` pending until a real maintainer records their review. These synthetic cases do not replace representative project tasks or evaluation with an explicitly supplied local semantic model.

## Run the offline gate

Use the Node SQLite runtime described in the development setup, then run:

```sh
node scripts/evaluate-context.mjs --iterations 3 --output context-evaluation-results/report.json
```

The command creates isolated temporary projects, indexes the corpus, exercises production retrieval and context packet APIs, writes a JSON report, then removes the temporary projects. It makes no provider or network calls. A failed current-stage evidence invariant produces a nonzero exit code and lists the case, stage and violation.

`tests/integration/context-evaluation.test.ts` runs the same gate during normal CI, with two timing samples per case/stage. Its report is retained under `context-evaluation-results/` for CI artifacts. The fixture's expected evidence and quality metrics are deterministic; timestamps, randomly generated project/revision identities, hardware-dependent latency, and database bytes may vary.

## What each stage measures

| Stage | Behavior and limits |
| --- | --- |
| `legacy_document_reference` | The document ranking function from baseline `5543694`, preserved as a reference. It has no revision citations or freshness policy. Its known invariant failures are reported rather than made passing retroactively. |
| `passage_lexical` | Actual source catalog FTS retrieval, with current-source filtering and exact revision/offset citations. |
| `unified_lexical` | The shared production retrieval service across source passages, tasks, typed knowledge, and project entities. |
| `graph_neighborhood` | Actual bounded graph queries, seeded by unambiguous curated alias matches, supplement passage results. This measures declared directory links; it does not claim general graph reasoning. |
| `hybrid_local_model` | Unavailable by default. An explicitly supplied local vector pack enables a separately reported experiment. |
| `context_packet` | The final production packet, including pinned categories, decisions and saved checkpoint evidence. With a supplied model it uses the async preview; otherwise it uses the synchronous lexical preparation used by claims. |

Ranked stages report recall@10 and reciprocal rank over expected source identities. Packet sections are grouped by category, so their order is not a retrieval ranking: packet quality is measured by complete evidence coverage and mandatory-category coverage. An explicitly expected missing category only passes when it is recorded as a gap and execution remains blocked. Scores also report citation validity, stale/excluded/foreign source inclusion, and superseded records presented as current guidance.

The report retains exact observed citation identities and passage spans for investigation. It compares current stages against the frozen document reference and reports recall regressions. A paraphrase fixture that overlaps lexical terms is a limited coverage check, not proof of semantic understanding.

## Acceptance targets

The blocking invariants for current stages are:

- Every case's `mustRetrieve` source must be present within the ranked top 10, or in the complete saved packet for the packet stage.
- Every required packet category is included, or explicitly recorded as the case's expected missing category with execution blocked.
- Citation/revision identities are correct; no unavailable, excluded, foreign-project, or superseded-current evidence is included.
- A new method must report quality regressions and missing mandatory evidence. A higher average score cannot excuse an invariant failure.

For the initial corpus, passage recall@10 is 1.0 and packet expected-evidence and mandatory-category coverage are 1.0. CI asserts these fixture targets. Unavailable optional stages have null metrics, never fabricated zero scores or invented improvement claims. No assertion certifies the dataset's pending human review.

Latency is measured around actual retrieval/packet calls. Reports contain p50/p95 over the measured cases and iterations, plus Node, SQLite, operating system, CPU, architecture, checkout revision and dirty-worktree state. The first timing sample includes caches as encountered; these are mixed first/repeated-call measurements rather than a controlled cold-start study. Timing is informational in shared CI. Investigate an uninstrumented p95 above 500 ms for lexical packet assembly or 100 ms for lexical retrieval on this small corpus, and compare repeated runs on the same machine before setting a hardware-specific blocking threshold.

A final implementation run on 2026-09-09 at 12:08 local time used Apple M2 Max, macOS arm64, Node 22.23.2 and SQLite 3.53.4, with three timing samples per case/stage. All current-stage gates passed across 54 observations, 778 sources and 1,178 passages. Source-index construction took about 523 ms and 5.05 MB of SQLite storage. Passage retrieval p50/p95 was approximately 0.42/1.20 ms, unified lexical retrieval 1.38/2.55 ms, and packet assembly 228/361 ms. The report is retained locally at `context-evaluation-results/final.json` and identifies the uncommitted implementation based on `5543694`. These values describe the synthetic catalog, not a production repository benchmark; no local semantic model was supplied and no provider calls were made.

## Token and model budgets

Reported `tokens` use a conservative UTF-8 byte upper bound, identified by `tokenEstimator`; they are not measured tokens from a particular language-model tokenizer. Provider calls, provider tokens and provider dollar cost are zero. The source-index timer covers fixture source publication and the structured graph projections; storage is captured after checkpointing SQLite and before generated task packets. Optional semantic build time is reported separately.

To evaluate a reviewed local word-vector asset explicitly:

```sh
node scripts/evaluate-context.mjs --model /absolute/path/reviewed-vector-pack.json --model-budget-ms 60000 --iterations 3 --output context-evaluation-results/local-model-report.json
```

The pack must use the format accepted by `SemanticIndexRepository`: `formatVersion`, `modelId`, `version`, `dimensions`, and a `vocabulary` mapping normalized tokens to vectors. The engine enforces an 8 MiB file, 10,000-word vocabulary, 128 dimensions, 5,000 passages, batches of 32, one worker, a 3-second worker timeout and 128 MiB worker memory. The runner adds a 60-second indexing budget by default, configurable up to 120 seconds, with at most 20 timing repetitions. Partial index coverage is reported explicitly. No model is downloaded and no remote-model evaluation is built into this runner. Synthetic synonym vectors used by engine tests establish plumbing behavior only; they must not be presented as semantic-quality evidence.

## Turn feedback into reviewed improvements

`ContextFeedbackRepository` stores reports linked to the work item, immutable packet ID, reporter, and source IDs. It captures both the packet's source revision and the source's current revision at report time. Human and agent reports begin as `proposed`; desktop owners can triage them toward a fixture, an independently reviewed knowledge correction, or no change. Every transition records its actor, explanation and version. A resolved correction/fixture must include a target reference.

The agent MCP report route forces `authorKind: agent`. Reporting and triage do not update decisions, requirements, sources, or accepted wiki content. Feedback survives task deletion so the original packet and investigation history remain inspectable. A maintainer can use a resolved report to propose a new corpus case, review its expected evidence, and rerun the gate before accepting changes.
