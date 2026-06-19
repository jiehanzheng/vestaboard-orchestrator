import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;
type CodexAppServerOperation<T> = (client: CodexAppServerClient) => Promise<T>;

const APP_SERVER_TIMEOUT_MS = 30_000;

export interface CodexAppServerClient {
  request<T>(method: string, params?: JsonObject): Promise<T>;
  waitForTurnCompletion(threadId: string, turnId: string): Promise<void>;
}

export async function withCodexAppServer<T>(operation: CodexAppServerOperation<T>): Promise<T> {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  if (!proc.stdin || !proc.stdout) {
    throw new Error("Could not open Codex app-server pipes.");
  }

  const lines = createInterface({ input: proc.stdout });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const notificationListeners = new Set<(message: { method: string; params?: unknown }) => void>();
  const notificationRejecters = new Set<(error: Error) => void>();
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    clearTimeout(timeout);
    lines.removeAllListeners();
    lines.close();
    proc.removeAllListeners("error");
    proc.removeAllListeners("exit");

    if (!proc.stdin.destroyed) {
      proc.stdin.end();
    }

    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
  };

  const fail = (error: Error): void => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
    for (const reject of notificationRejecters.values()) {
      reject(error);
    }
    notificationRejecters.clear();
    cleanup();
  };

  const timeout = setTimeout(() => {
    fail(new Error(`Codex app-server timed out after ${APP_SERVER_TIMEOUT_MS}ms.`));
  }, APP_SERVER_TIMEOUT_MS);

  const send = (message: JsonObject): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = <T>(method: string, params?: JsonObject): Promise<T> => {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      send(params ? { method, id, params } : { method, id });
    });
  };

  const waitForTurnCompletion = (threadId: string, turnId: string): Promise<void> => new Promise((resolve, reject) => {
    const listener = (message: { method: string; params?: unknown }): void => {
      if (message.method !== "turn/completed") {
        return;
      }

      const params = message.params as { threadId?: string; turn?: { id?: string; status?: string; error?: unknown } } | undefined;
      if (params?.threadId !== threadId || params.turn?.id !== turnId) {
        return;
      }

      notificationListeners.delete(listener);
      notificationRejecters.delete(reject);
      if (params.turn.status === "failed") {
        reject(new Error(`Codex auto-start turn failed: ${JSON.stringify(params.turn.error)}`));
      } else {
        resolve();
      }
    };
    notificationListeners.add(listener);
    notificationRejecters.add(reject);
  });

  lines.on("line", (line) => {
    let message: { id?: number; method?: string; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error(`Invalid JSON from Codex: ${line}`));
      return;
    }

    if (message.method !== undefined) {
      notificationListeners.forEach((listener) => listener({ method: message.method as string, params: (message as { params?: unknown }).params }));
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    pending.delete(message.id);
    if (message.error !== undefined) {
      entry.reject(new Error(`Codex app-server error: ${JSON.stringify(message.error)}`));
    } else {
      entry.resolve(message.result);
    }
  });

  proc.on("error", (error) => fail(new Error(`Could not start Codex: ${error.message}`)));
  proc.on("exit", (code, signal) => {
    if (pending.size > 0) {
      fail(new Error(`Codex app-server exited before responding: code=${code}, signal=${signal}`));
    }
  });

  try {
    await request("initialize", {
      clientInfo: {
        name: "vestaboard_orchestrator",
        title: "Vestaboard Orchestrator",
        version: "0.1.0"
      }
    });
    send({ method: "initialized", params: {} });
    return await operation({ request, waitForTurnCompletion });
  } finally {
    cleanup();
  }
}
