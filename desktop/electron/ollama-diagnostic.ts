import { request } from "node:http";

export type OllamaDiagnostic = Readonly<{
  kind: "ready" | "unavailable" | "model-missing" | "invalid-config";
  title: string;
  message: string;
}>;

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_CHAT_MODEL = "llama3.2:3b";
const MAX_RESPONSE_BYTES = 256 * 1024;

function isLoopbackHost(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const octets = hostname.split(".").map(Number);
  return octets.length === 4
    && octets[0] === 127
    && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

export function parseLoopbackOllamaUrl(configured?: string) {
  let url: URL;
  try {
    url = new URL(configured?.trim() || DEFAULT_OLLAMA_URL);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) {
    return null;
  }
  return url;
}

async function fetchInstalledModels(baseUrl: URL, timeoutMs: number) {
  return await new Promise<string[]>((resolve, reject) => {
    const url = new URL("/api/tags", baseUrl);
    const localRequest = request(url, { method: "GET", timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Ollama returned a non-success status."));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          localRequest.destroy(new Error("Ollama returned too much diagnostic data."));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { models?: Array<{ name?: unknown; model?: unknown }> };
          const names = Array.isArray(body.models)
            ? body.models.flatMap((model) => [model.name, model.model]).filter((name): name is string => typeof name === "string")
            : [];
          resolve(names);
        } catch (error) {
          reject(error);
        }
      });
    });
    localRequest.once("timeout", () => localRequest.destroy(new Error("Ollama diagnostic timed out.")));
    localRequest.once("error", reject);
    localRequest.end();
  });
}

export async function diagnoseLocalOllama(input: {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
} = {}): Promise<OllamaDiagnostic> {
  const baseUrl = parseLoopbackOllamaUrl(input.baseUrl);
  if (!baseUrl) {
    return Object.freeze({
      kind: "invalid-config",
      title: "Local Ollama configuration blocked",
      message: "Rangabot only connects to Ollama over local loopback HTTP. No connection or download was attempted.",
    });
  }
  const model = input.model?.trim() || DEFAULT_CHAT_MODEL;
  let installed: string[];
  try {
    installed = await fetchInstalledModels(baseUrl, input.timeoutMs ?? 1_500);
  } catch {
    return Object.freeze({
      kind: "unavailable",
      title: "Ollama is not running",
      message: `Start Ollama locally at ${baseUrl.origin} before using Rangabot's model features. Rangabot did not connect to the internet or download anything.`,
    });
  }
  if (!installed.some((installedModel) => installedModel === model || installedModel.startsWith(`${model}:`))) {
    return Object.freeze({
      kind: "model-missing",
      title: "Local Ollama model is missing",
      message: `Rangabot needs the local Ollama model “${model}”. Install it separately in Ollama, then reopen Rangabot. No download was attempted.`,
    });
  }
  return Object.freeze({ kind: "ready", title: "Ollama is ready", message: "The configured local Ollama model is available." });
}
