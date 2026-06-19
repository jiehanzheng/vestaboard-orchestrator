import type { CodexAppServerClient } from "./appServer.js";
import type { QuotaRowName, QuotaSnapshot, QuotaWindow } from "./types.js";

interface ModelListResult {
  data: CodexModel[];
  nextCursor?: string | null;
}

interface CodexModel {
  id: string;
  model: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
}

interface ReasoningEffortOption {
  reasoningEffort: string;
}

interface ThreadStartResult {
  thread: {
    id: string;
  };
}

interface TurnStartResult {
  turn: {
    id: string;
    status: string;
  };
}

export interface AutoStartQuotaConfig {
  fiveHour: boolean;
  weekly: boolean;
}

type AutoStartWindowId = "fiveHour" | "weekly";

export interface AutoStartWindowCandidate {
  id: AutoStartWindowId;
  row: QuotaRowName;
  resetAtMs: number;
}

type AutoStartPingPlan =
  | { type: "skip"; reason: "no-eligible-window" | "cooldown" }
  | { type: "ping"; trigger: "force"; windows: [] }
  | { type: "ping"; trigger: "unused-quota"; windows: AutoStartWindowCandidate[] };

const AUTO_START_BASE_INSTRUCTIONS = "Obey exactly.";
const AUTO_START_PROMPT = "Reply exactly: ok. Do not inspect files or run commands.";
const AUTO_START_PING_COOLDOWN_MS = 30 * 60_000;

export class CodexAutoStartSidecar {
  constructor(
    private readonly config: AutoStartQuotaConfig,
    private readonly state = new AutoStartPingState()
  ) {}

  async afterQuotaRead({
    client,
    snapshot,
    force,
    now
  }: {
    client: CodexAppServerClient;
    snapshot: QuotaSnapshot;
    force: boolean;
    now: Date;
  }): Promise<{ statusMessage?: string }> {
    const plan = this.state.plan(snapshot, this.config, { force, now });
    if (plan.type === "skip") {
      return {};
    }

    const models = await readAllModels(client);
    const selection = selectAutoStartModel(models);
    await sendAutoStartPrompt(client, selection);
    this.state.recordSuccess(plan, new Date());
    return { statusMessage: autoStartPingMessage(selection) };
  }
}

export class AutoStartPingState {
  private lastSuccessfulPingAtMs: number | undefined;
  private pingedResetAtMsByWindow: Partial<Record<AutoStartWindowId, number>> = {};

  plan(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig, options: { force: boolean; now: Date }): AutoStartPingPlan {
    if (options.force) {
      return { type: "ping", trigger: "force", windows: [] };
    }

    if (this.isInCooldown(options.now)) {
      return { type: "skip", reason: "cooldown" };
    }

    const windows = this.eligibleWindows(snapshot, config);
    return windows.length > 0
      ? { type: "ping", trigger: "unused-quota", windows }
      : { type: "skip", reason: "no-eligible-window" };
  }

  recordSuccess(plan: Extract<AutoStartPingPlan, { type: "ping" }>, now: Date): void {
    this.lastSuccessfulPingAtMs = now.getTime();
    if (plan.trigger === "force") {
      return;
    }

    for (const window of plan.windows) {
      this.pingedResetAtMsByWindow[window.id] = window.resetAtMs;
    }
  }

  private isInCooldown(now: Date): boolean {
    return this.lastSuccessfulPingAtMs !== undefined
      && now.getTime() - this.lastSuccessfulPingAtMs < AUTO_START_PING_COOLDOWN_MS;
  }

  private eligibleWindows(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig): AutoStartWindowCandidate[] {
    return [
      this.windowCandidate("fiveHour", "5H", config.fiveHour, snapshot.fiveHour),
      this.windowCandidate("weekly", "WK", config.weekly, snapshot.weekly)
    ].filter((window): window is AutoStartWindowCandidate => window !== undefined);
  }

  private windowCandidate(
    id: AutoStartWindowId,
    row: QuotaRowName,
    enabled: boolean,
    window: QuotaWindow | undefined
  ): AutoStartWindowCandidate | undefined {
    if (!enabled || !isUnusedQuotaWindow(window)) {
      return undefined;
    }

    const resetAtMs = window.resetAt.getTime();
    return this.pingedResetAtMsByWindow[id] === resetAtMs ? undefined : { id, row, resetAtMs };
  }
}

export function selectAutoStartModel(models: CodexModel[]): { model: string; reasoningEffort: string } {
  const filteredModels = models.filter((model) => !model.model.includes("-spark"));
  const selectedModel = findModelWithSuffix(filteredModels, "-nano")
    ?? findModelWithSuffix(filteredModels, "-mini")
    ?? filteredModels.at(-1);

  if (!selectedModel) {
    throw new Error("Codex model list did not contain an auto-start model candidate.");
  }

  const reasoningEffort = selectedModel.supportedReasoningEfforts[0]?.reasoningEffort;
  if (!reasoningEffort) {
    throw new Error(`Codex model ${selectedModel.model} did not include a reasoning effort.`);
  }

  return {
    model: selectedModel.model,
    reasoningEffort
  };
}

function isUnusedQuotaWindow(window: QuotaWindow | undefined): window is QuotaWindow {
  return window !== undefined && clamp(window.remainingRatio) >= 1;
}

function autoStartPingMessage(selection: { model: string; reasoningEffort: string }): string {
  return `ping ${selection.model}${selection.reasoningEffort}`;
}

async function readAllModels(client: CodexAppServerClient): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  let cursor: string | null | undefined;

  do {
    const page = await client.request<ModelListResult>("model/list", { limit: 100, includeHidden: false, cursor });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  return models;
}

function findModelWithSuffix(models: CodexModel[], suffix: string): CodexModel | undefined {
  return [...models].reverse().find((model) => model.model.endsWith(suffix));
}

async function sendAutoStartPrompt(client: CodexAppServerClient, selection: { model: string; reasoningEffort: string }): Promise<void> {
  const thread = await client.request<ThreadStartResult>("thread/start", {
    model: selection.model,
    approvalPolicy: "never",
    sandbox: "read-only",
    cwd: process.cwd(),
    baseInstructions: AUTO_START_BASE_INSTRUCTIONS,
    ephemeral: true,
    threadSource: "user"
  });
  const turn = await client.request<TurnStartResult>("turn/start", {
    threadId: thread.thread.id,
    input: [{ type: "text", text: AUTO_START_PROMPT, text_elements: [] }],
    model: selection.model,
    effort: selection.reasoningEffort,
    approvalPolicy: "never"
  });

  if (turn.turn.status === "completed") {
    return;
  }

  await client.waitForTurnCompletion(thread.thread.id, turn.turn.id);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
