import type { CodexAppServerClient } from "./appServer.js";
import {
  QuotaWindowHistory,
  type AutoStartPingPlan,
  type AutoStartQuotaConfig,
  type AutoStartWindowCandidate
} from "./quotaWindowHistory.js";
import type { QuotaSnapshot } from "./types.js";

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

const AUTO_START_BASE_INSTRUCTIONS = "Obey exactly.";
const AUTO_START_PROMPT = "Reply exactly: ok. Do not inspect files or run commands.";

export class CodexAutoStartSidecar {
  constructor(
    private readonly config: AutoStartQuotaConfig,
    private readonly history = new QuotaWindowHistory()
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
    const plan = this.history.planAutoStart(snapshot, this.config, { force, now });
    if (plan.type === "skip") {
      return {};
    }

    const models = await readAllModels(client);
    const selection = selectAutoStartModel(models);
    await sendAutoStartPrompt(client, selection);
    this.history.recordPingSuccess(plan, new Date());
    return { statusMessage: autoStartPingMessage(selection) };
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

function autoStartPingMessage(selection: { model: string; reasoningEffort: string }): string {
  return `ping ${selection.model.replaceAll("-", "")}${selection.reasoningEffort}`;
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
  if (turn.turn.status !== "inProgress") {
    throw new Error(`Codex auto-start turn started with status ${turn.turn.status || "unknown"}.`);
  }

  await client.waitForTurnCompletion(thread.thread.id, turn.turn.id);
}

export type { AutoStartPingPlan, AutoStartQuotaConfig, AutoStartWindowCandidate };
