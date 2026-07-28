export type KnowledgeBriefItem = {
  category: string;
  title: string;
  date: string;
  change: string;
  why: string;
  evidenceLabel: string;
  evidenceUrl?: string;
  vaultStatus: string;
};

function field(block: string, label: string) {
  const match = block.match(new RegExp(`^- \\*\\*${label}:\\*\\*\\s*(.+)$`, "mi"));
  return match?.[1]?.trim() ?? "";
}

export function parseKnowledgeBrief(markdown: string): KnowledgeBriefItem[] {
  let category = "Updates";
  let current: { category: string; title: string; lines: string[] } | null = null;
  const entries: Array<{ category: string; title: string; block: string }> = [];

  for (const line of markdown.split("\n")) {
    if (line.startsWith("### ")) {
      category = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("#### ")) {
      if (current) entries.push({ ...current, block: current.lines.join("\n") });
      current = { category, title: line.slice(5).trim(), lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) entries.push({ ...current, block: current.lines.join("\n") });

  return entries.map(({ category: entryCategory, title, block }) => {
    const evidence = field(block, "Evidence");
    const link = evidence.match(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/);
    return {
      category: entryCategory,
      title,
      date: field(block, "Event dates?") || field(block, "Event date"),
      change: field(block, "What changed"),
      why: field(block, "Why it matters"),
      evidenceLabel: evidence.replace(/\[([^\]]+)]\([^)]+\)/, "$1"),
      evidenceUrl: link?.[2],
      vaultStatus: field(block, "Vault status"),
    };
  });
}
