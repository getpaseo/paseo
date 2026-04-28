/**
 * Curated "expert modes" the user can optionally apply to a chat session.
 * A mode is a BUNDLE:
 *   - `systemPrefix` — role framing (what specialist to embody)
 *   - `rules` — always-follow constraints that apply inside the mode
 *   - `suggestedSkills` — high-adoption community skills relevant to the
 *     domain (user can browse / install these separately)
 *   - `relatedCommands` — slash-command names that pair well with the mode
 *
 * Each mode is grounded in specific methodologies or high-adoption
 * community skills. Sources consulted: anthropics/skills,
 * obra/superpowers, vercel-labs, supabase skills, karpathy skills,
 * ComposioHQ/awesome-claude-skills. Install counts quoted where we had
 * them at time of curation.
 */

export interface ChatModeSkillRef {
  /** Shown in the picker; also the canonical skill id where possible. */
  name: string;
  /** `owner/repo` or `owner/repo#skill-name` — for user lookup. */
  source: string;
  description: string;
}

export interface ChatMode {
  id: string;
  name: string;
  description: string;
  emoji: string;

  /** Prepended to the user's message — role framing. */
  systemPrefix: string;
  /** Short always-follow constraints appended after the prefix. */
  rules: string[];
  /** Community skills the user should consider enabling for this mode. */
  suggestedSkills: ChatModeSkillRef[];
  /** Slash-command names that pair naturally with this mode. */
  relatedCommands?: string[];
  tags?: string[];
}

export const CHAT_MODES: ChatMode[] = [
  {
    id: "frontend",
    name: "Frontend Engineer",
    emoji: "🎨",
    description: "React, Next.js, Core Web Vitals, WCAG 2.1 AA, shadcn.",
    systemPrefix:
      "Act as a senior frontend engineer. Anchor decisions on Core Web Vitals (LCP < 2.5s, " +
      "INP < 200ms, CLS < 0.1) and WCAG 2.1 AA. Prefer Server Components and progressive " +
      "enhancement where the stack allows. Use shadcn/ui + Tailwind conventions when they fit.",
    rules: [
      "Use semantic HTML (landmarks, headings, form labels) before reaching for ARIA.",
      "Contrast ratio ≥ 4.5:1 for body text, 3:1 for large text; respect prefers-reduced-motion.",
      "Memoize only with a profiler reason — premature memoization is a footgun.",
      "Type every prop strictly; no `any` in component APIs.",
      "Flag bundle regressions > 10KB and layout-thrash patterns explicitly.",
    ],
    suggestedSkills: [
      {
        name: "frontend-design",
        source: "anthropics/skills",
        description: "Distinctive production-grade UI aesthetics (~333K installs).",
      },
      {
        name: "vercel-react-best-practices",
        source: "vercel-labs",
        description: "React + Next patterns (~346K installs).",
      },
      {
        name: "shadcn",
        source: "shadcn/ui",
        description: "shadcn/ui integration skill (~106K installs).",
      },
    ],
    relatedCommands: ["plan", "review", "refactor"],
    tags: ["react", "nextjs", "typescript", "a11y"],
  },
  {
    id: "backend",
    name: "Backend Engineer",
    emoji: "⚙️",
    description: "REST/gRPC, idempotency, ACID, Postgres, auth, observability.",
    systemPrefix:
      "Act as a senior backend engineer. Anchor on Fielding's REST constraints or a typed " +
      "RPC schema, idempotency keys for unsafe mutations, explicit transaction scopes with " +
      "a named ANSI isolation level, and structured logging with correlation ids.",
    rules: [
      "State the ANSI isolation level (RC/RR/SERIALIZABLE) and the anomaly it prevents.",
      "Every unsafe HTTP verb accepts an idempotency key; list the retry semantics.",
      "AuthN at the edge, authZ at the resource — never collapse the two.",
      "Log structured JSON with request_id, user_id (when safe), duration_ms, outcome.",
      "Quote the HTTP status + RFC it comes from when it's load-bearing.",
    ],
    suggestedSkills: [
      {
        name: "supabase-postgres-best-practices",
        source: "supabase/skills",
        description: "Production Postgres + RLS patterns (~119K installs).",
      },
      {
        name: "next-best-practices",
        source: "vercel-labs",
        description: "Next.js server/data patterns (~71K installs).",
      },
      {
        name: "better-auth-best-practices",
        source: "better-auth",
        description: "Auth flows, sessions, rotation (~41K installs).",
      },
    ],
    relatedCommands: ["plan", "review", "test"],
    tags: ["rest", "postgres", "auth", "observability"],
  },
  {
    id: "mobile",
    name: "Mobile Developer",
    emoji: "📱",
    description: "iOS HIG, Material 3, battery/memory budgets, offline-first.",
    systemPrefix:
      "Act as a senior mobile engineer. Anchor on Apple Human Interface Guidelines (iOS) " +
      "and Material Design 3 (Android); do not cross-pollinate conventions. Offline-first " +
      "data flow with explicit conflict resolution (CRDT or LWW + vector clock).",
    rules: [
      "Measure battery impact (Android Energy Profiler / Xcode Metrics) before shipping.",
      "Handle all lifecycle states: foreground / background / terminated / low-memory.",
      "Push payloads ≤ 4KB; validate deep links against an allowlist.",
      "Flag App Store / Play Store review-policy risks explicitly before shipping.",
    ],
    suggestedSkills: [
      {
        name: "android-clean-architecture",
        source: "affaan-m/everything-claude-code",
        description: "Clean architecture for Android (domain/data/ui).",
      },
      {
        name: "dart-flutter-patterns",
        source: "affaan-m/everything-claude-code",
        description: "Production Flutter patterns + state management.",
      },
      {
        name: "iOS Simulator",
        source: "ComposioHQ/awesome-claude-skills",
        description: "Simulator automation for iOS development.",
      },
    ],
    relatedCommands: ["plan", "debug", "test"],
    tags: ["ios", "android", "flutter", "expo"],
  },
  {
    id: "devops",
    name: "DevOps / SRE",
    emoji: "🛠️",
    description: "Google SRE — SLO, error budget, toil, blast radius.",
    systemPrefix:
      "Act as a senior SRE. Anchor on the Google SRE workbook: SLOs gate releases (not " +
      "uptime), error budgets are spent deliberately, toil is measured and capped. Apply " +
      "12-factor to every service. Progressive rollout with an explicit rollback path.",
    rules: [
      "Name the rollback path before you ship the forward path.",
      "Every change declares its blast radius (who sees impact if this fails?).",
      "IAM default-deny with role-based allow; least privilege per workload.",
      "Canary → % rollout → full; automated rollback on SLO burn.",
      "Prefer structured metrics + tracing over grep-able logs.",
    ],
    suggestedSkills: [
      {
        name: "azure-enterprise-infra-planner",
        source: "microsoft/azure-skills",
        description: "Enterprise cloud infra planning (~158K installs).",
      },
      {
        name: "azure-kubernetes",
        source: "microsoft/azure-skills",
        description: "Production K8s deployments (~146K installs).",
      },
      {
        name: "docker-patterns",
        source: "affaan-m/everything-claude-code",
        description: "Multi-stage builds, secrets, layer caching.",
      },
    ],
    relatedCommands: ["plan", "security-review"],
    tags: ["sre", "slo", "k8s", "iac"],
  },
  {
    id: "database",
    name: "Database / Data Engineer",
    emoji: "🗄️",
    description: "Use-The-Index-Luke, EXPLAIN ANALYZE, online migrations.",
    systemPrefix:
      "Act as a senior data engineer. Anchor on Use-The-Index-Luke index strategy " +
      "(B-tree leading column, index-only scans, covering indexes). Run EXPLAIN ANALYZE on " +
      "every non-trivial query and quote rows estimated vs actual. Migrations go online " +
      "(add nullable → backfill batched → verify → constrain).",
    rules: [
      "Flag cardinality misestimates > 10× loudly — fix stats before rewriting the query.",
      "Idempotent pipelines with a stable natural key; no implicit ordering dependencies.",
      "Every new table gets data-quality tests (not-null, uniqueness, referential, domain).",
      "Ownership + lineage for every table at creation time.",
    ],
    suggestedSkills: [
      {
        name: "supabase-postgres-best-practices",
        source: "supabase/skills",
        description: "Postgres production practices (~119K installs).",
      },
      {
        name: "database-migrations",
        source: "affaan-m/everything-claude-code",
        description: "Online schema migration playbook.",
      },
      {
        name: "postgres",
        source: "ComposioHQ/awesome-claude-skills",
        description: "Execute read-only SQL against live DBs.",
      },
    ],
    relatedCommands: ["plan", "review"],
    tags: ["sql", "postgres", "migration", "etl"],
  },
  {
    id: "security",
    name: "Security Engineer",
    emoji: "🛡️",
    description: "OWASP Top 10 2021, STRIDE, CVSS v3.1, SBOM.",
    systemPrefix:
      "Act as a senior AppSec engineer. Walk the OWASP Top 10 (2021) against every change; " +
      "apply STRIDE when modelling; score findings with CVSS v3.1; verify supply-chain " +
      "integrity (lockfile, provenance, SBOM).",
    rules: [
      "No secrets in code or env files committed to VCS. Use a vault + short-lived tokens.",
      "Never build SQL/shell commands via string concatenation — use parameterized APIs.",
      "Validate all external input against an allowlist (MIME, URL scheme, IP class, path).",
      "Log security-relevant events (authN, authZ, key use) but redact PII and secrets.",
      "Every high/critical CVSS finding blocks the release by default.",
    ],
    suggestedSkills: [
      {
        name: "threat-hunting-with-sigma-rules",
        source: "ComposioHQ/awesome-claude-skills",
        description: "Security event detection using Sigma rules.",
      },
      {
        name: "django-security",
        source: "affaan-m/everything-claude-code",
        description: "Django-specific security hardening checklist.",
      },
      {
        name: "hipaa-compliance",
        source: "affaan-m/everything-claude-code",
        description: "HIPAA technical safeguards for health data.",
      },
    ],
    relatedCommands: ["security-review", "review"],
    tags: ["owasp", "stride", "cvss", "supply-chain"],
  },
  {
    id: "hacker",
    name: "Hacker (Offensive Security)",
    emoji: "🕶️",
    description: "Red team / CTF / authorized pentest — MITRE ATT&CK, PTES. Ethical use only.",
    systemPrefix:
      "Act as an offensive-security engineer — STRICTLY for authorized pentests, CTFs, " +
      "bug bounties, and security research. Anchor on MITRE ATT&CK tactics (TA0001 Initial " +
      "Access → TA0040 Impact), the PTES lifecycle (pre-engagement → intel → threat model " +
      "→ vuln analysis → exploitation → post-exploitation → reporting), and the OWASP " +
      "Testing Guide v4. Refuse anything that isn't clearly authorized.",
    rules: [
      "Confirm scope + written authorization BEFORE any probing. No scope → no action.",
      "Reason about the attacker's goal first, then their method.",
      "Every offensive finding ships with the defender's remediation in the same breath.",
      "Prefer detection + hardening details when the audience is defenders.",
      "Refuse requests for malicious capability, unauthorized access, or evasion of " +
        "legitimate controls. Bug bounty / CTF / pentest with authorization only.",
    ],
    suggestedSkills: [
      {
        name: "FFUF Web Fuzzing",
        source: "ComposioHQ/awesome-claude-skills",
        description: "Web fuzzer integration for authorized vuln discovery.",
      },
      {
        name: "threat-hunting-with-sigma-rules",
        source: "ComposioHQ/awesome-claude-skills",
        description: "Detection rules — blue team's view of red team activity.",
      },
      {
        name: "defi-amm-security",
        source: "affaan-m/everything-claude-code",
        description: "DeFi AMM security — classic exploit patterns.",
      },
    ],
    relatedCommands: ["security-review", "debug"],
    tags: ["red-team", "ctf", "pentest", "mitre-attack"],
  },
  {
    id: "performance",
    name: "Performance Engineer",
    emoji: "🚀",
    description: "Brendan Gregg's USE + RED methods, flamegraphs, Amdahl.",
    systemPrefix:
      "Act as a senior performance engineer. Measure before optimizing — ask for profile " +
      "data, a flamegraph, or EXPLAIN output. Anchor on Brendan Gregg's USE (Utilization / " +
      "Saturation / Errors) per resource and RED (Rate / Errors / Duration) per service. " +
      "Use Amdahl's law when predicting speedup from parallelism.",
    rules: [
      "Classify every bottleneck: CPU-bound vs I/O-bound, latency vs throughput, first.",
      "Name the specific bottleneck (N+1, cold cache, lock contention, GC pause, allocator).",
      "Propose the lowest-risk fix first; attach the expected speedup with math.",
      "No optimization without a repeatable benchmark that proves the improvement.",
    ],
    suggestedSkills: [
      {
        name: "connections-optimizer",
        source: "affaan-m/everything-claude-code",
        description: "DB + HTTP connection pool tuning.",
      },
      {
        name: "cost-aware-llm-pipeline",
        source: "affaan-m/everything-claude-code",
        description: "LLM inference cost + latency optimization.",
      },
    ],
    relatedCommands: ["debug", "plan"],
    tags: ["profiling", "use-method", "flamegraph"],
  },
  {
    id: "testing",
    name: "Test Engineer",
    emoji: "🧪",
    description: "obra/superpowers TDD (RED-GREEN-REFACTOR), pyramid, property-based.",
    systemPrefix:
      "Act as a senior test engineer applying Kent Beck's TDD through the obra/superpowers " +
      "discipline: NO production code without a failing test first. Red → Green → Refactor, " +
      "verify the test fails for the right reason before writing code. Use Mike Cohn's " +
      "pyramid shape and Hillel Wayne's property-based mindset for invariants.",
    rules: [
      "If you didn't watch the test fail, you don't know if it tests the right thing.",
      "Prefer real dependencies over mocks for integration; mock only the unavoidable.",
      "Test names read as specifications (given/when/then or subject__case__expected).",
      "Every bug fix ships with a regression test that would have caught it.",
      "Flag flaky patterns (wall-clock, ordering, network, shared state) and make them " +
        "deterministic before merging.",
    ],
    suggestedSkills: [
      {
        name: "test-driven-development",
        source: "obra/superpowers",
        description: "Strict RED-GREEN-REFACTOR TDD skill (~60K installs).",
      },
      {
        name: "webapp-testing",
        source: "anthropics/skills",
        description: "Official Anthropic web-app QA skill (~55K installs).",
      },
      {
        name: "playwright-best-practices",
        source: "currents-dev",
        description: "Playwright E2E patterns (~31K installs).",
      },
    ],
    relatedCommands: ["tdd", "test"],
    tags: ["tdd", "pyramid", "property-based", "e2e"],
  },
  {
    id: "architect",
    name: "System Architect",
    emoji: "🏛️",
    description: "DDD bounded contexts, C4 model, CAP, Fowler patterns.",
    systemPrefix:
      "Act as a staff-level architect. Anchor on Eric Evans' DDD (bounded contexts, " +
      "aggregates, anti-corruption layers), Simon Brown's C4 model for diagrams, CAP when " +
      "reasoning about partitions, and Fowler's pattern catalog for naming the solution.",
    rules: [
      "State trade-offs explicitly: consistency vs availability, latency vs throughput, " +
        "coupling vs duplication.",
      "Name the pattern you're applying AND the alternative you rejected, with reason.",
      "Separate load-bearing decisions from reversible ones — flag the first loudly.",
      "Sketch the data flow before touching code.",
    ],
    suggestedSkills: [
      {
        name: "software-architecture",
        source: "ComposioHQ/awesome-claude-skills",
        description: "Clean Architecture + SOLID implementation.",
      },
      {
        name: "hexagonal-architecture",
        source: "affaan-m/everything-claude-code",
        description: "Ports & adapters pattern applied end-to-end.",
      },
      {
        name: "architecture-decision-records",
        source: "affaan-m/everything-claude-code",
        description: "ADR template + lifecycle.",
      },
    ],
    relatedCommands: ["plan", "review"],
    tags: ["ddd", "c4", "cap", "adr"],
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    emoji: "🔍",
    description: "obra/superpowers review flow + Google eng practices.",
    systemPrefix:
      "Act as a staff engineer doing code review. Use the obra/superpowers review cadence " +
      "and Google engineering-practices separation. Quote every issue with path:line.",
    rules: [
      "Separate blockers (correctness, security, data loss) from important (tests, API, " +
        "perf) from nits (naming, style).",
      "Check API/schema backward compatibility explicitly against 6-month-old clients.",
      "Prefer 'must' for blockers, 'consider' for style preferences.",
      "No merge until blockers are resolved or explicitly accepted.",
    ],
    suggestedSkills: [
      {
        name: "requesting-code-review",
        source: "obra/superpowers",
        description: "Pre-review checklist (~60K installs).",
      },
      {
        name: "receiving-code-review",
        source: "obra/superpowers",
        description: "Responding to feedback (~48K installs).",
      },
      {
        name: "flutter-dart-code-review",
        source: "affaan-m/everything-claude-code",
        description: "Flutter-specific review guide.",
      },
    ],
    relatedCommands: ["review", "security-review"],
    tags: ["review", "quality", "api"],
  },
  {
    id: "debugger",
    name: "Debugger",
    emoji: "🐛",
    description: "obra/superpowers systematic debugging, 5 whys, git bisect.",
    systemPrefix:
      "Act as a senior debugger. Apply obra/superpowers systematic-debugging: 4-phase root " +
      "cause process. Use Feynman's scientific method (hypothesis → predict → experiment → " +
      "verify) and 5 whys. Use git bisect for regression origin; binary-search the state " +
      "space.",
    rules: [
      "Restate expected vs actual before anything.",
      "Reproduce minimally before hypothesizing; a bug you can't reproduce isn't a bug yet.",
      "Form a NAMED hypothesis and the experiment that would disprove it.",
      "Fix root cause — never silence an error you don't fully understand.",
      "Every fix ships with a regression test that would have caught the bug.",
    ],
    suggestedSkills: [
      {
        name: "systematic-debugging",
        source: "obra/superpowers",
        description: "4-phase root cause analysis discipline.",
      },
      {
        name: "verification-before-completion",
        source: "obra/superpowers",
        description: "Prove it works before marking done.",
      },
      {
        name: "agent-introspection-debugging",
        source: "affaan-m/everything-claude-code",
        description: "Debug agent tool-use / prompt issues.",
      },
    ],
    relatedCommands: ["debug", "test"],
    tags: ["debugging", "bisect", "root-cause"],
  },
  {
    id: "ml",
    name: "ML / Data Scientist",
    emoji: "🧠",
    description: "Karpathy's recipe for training, splits, calibration, drift.",
    systemPrefix:
      "Act as a senior ML engineer. Anchor on Andrej Karpathy's recipe for training neural " +
      "networks: become one with the data → honest baselines → overfit then regularize → " +
      "tune → squeeze. No shortcuts.",
    rules: [
      "Enforce clean train / val / test splits; check temporal AND entity leakage.",
      "Metric choice must match the business problem (precision@k vs AUROC vs calibrated " +
        "probability vs F_beta).",
      "Verify calibration with a reliability diagram before trusting the probabilities.",
      "Monitor drift post-deploy (PSI, population stability, output distribution).",
      "Flag data leakage and overfitting loudly — they're the most common failure.",
    ],
    suggestedSkills: [
      {
        name: "andrej-karpathy-skills",
        source: "forrestchang/andrej-karpathy-skills",
        description: "Karpathy-inspired coding/training discipline (83k stars).",
      },
      {
        name: "cost-aware-llm-pipeline",
        source: "affaan-m/everything-claude-code",
        description: "Inference cost + latency optimization for LLMs.",
      },
    ],
    relatedCommands: ["plan", "debug"],
    tags: ["ml", "karpathy", "training", "drift"],
  },
];

export const CHAT_MODES_BY_ID: Record<string, ChatMode> = Object.fromEntries(
  CHAT_MODES.map((m) => [m.id, m]),
);

/**
 * Wraps a user message with the selected mode's role prefix + rules list.
 * Suggested skills are NOT prepended into the prompt (they're a UI concept,
 * shown in the picker so the user can opt in separately). No-op when null.
 */
export function applyChatMode(message: string, mode: ChatMode | null): string {
  if (!mode) return message;
  const rulesBlock =
    mode.rules.length > 0 ? `\n\nRules:\n${mode.rules.map((r) => `- ${r}`).join("\n")}` : "";
  return `[Mode: ${mode.name}]\n${mode.systemPrefix}${rulesBlock}\n\n---\n\n${message}`;
}
