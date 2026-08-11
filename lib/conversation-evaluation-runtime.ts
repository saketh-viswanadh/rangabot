import { execFileSync } from "node:child_process";

export type ConversationGitCandidate = { commit: string; dirty: boolean };

type CommandRunner = (command: string, args: string[]) => string;

function defaultCommandRunner(command: string, args: string[]) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function readConversationEvaluationGitCandidate(run: CommandRunner = defaultCommandRunner): ConversationGitCandidate {
  const commit = run("git", ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error("Conversation evaluation requires a valid SHA-1 or SHA-256 Git HEAD.");
  }
  const status = run("git", ["status", "--porcelain"]);
  return { commit, dirty: Boolean(status.trim()) };
}
