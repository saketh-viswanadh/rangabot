import type { KnowledgeChunkInput } from "./knowledge";

export function chunkHierarchicalText(text: string, target = 1_200, overlap = 180): Array<Omit<KnowledgeChunkInput, "id" | "ordinal">> {
  type Block = { text: string; heading?: string; sectionPath?: string; page?: number };
  const blocks: Block[] = [];
  const headings: string[] = [];
  let page: number | undefined;
  let paragraph: string[] = [];
  const flush = () => {
    const value = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (value) blocks.push({ text: value, heading: headings.at(-1), sectionPath: headings.join(" > ") || undefined, page });
    paragraph = [];
  };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const pageMarker = line.match(/^\[Page\s+(\d+)\]$/i);
    if (pageMarker) { flush(); page = Number(pageMarker[1]); continue; }
    const markdownHeading = line.match(/^(#{1,6})\s+(.+)$/);
    const inferredHeading = !markdownHeading && line.length <= 120 ? line.match(/^(?:(chapter|part|book)\s+[\divxlcdm]+|(?:section|lesson)\s+\d+(?:\.\d+)*)(?:\s*[:.\-–—]\s*|\s+)(.*)$/i) : null;
    if (markdownHeading || inferredHeading) {
      flush();
      const level = markdownHeading ? markdownHeading[1].length : /^(part|book)\b/i.test(line) ? 1 : /^(chapter)\b/i.test(line) ? 2 : 3;
      const title = (markdownHeading?.[2] ?? line).trim();
      headings.splice(level - 1);
      headings[level - 1] = title;
      continue;
    }
    if (!line) { flush(); continue; }
    paragraph.push(line);
  }
  flush();
  const expanded = blocks.flatMap((block) => {
    if (block.text.length <= target * 1.5) return [block];
    const pieces: Block[] = [];
    for (let start = 0; start < block.text.length; start += target - overlap) pieces.push({ ...block, text: block.text.slice(start, start + target) });
    return pieces;
  });
  const chunks: Array<Omit<KnowledgeChunkInput, "id" | "ordinal">> = [];
  let current: Block[] = [];
  const finishChunk = () => {
    if (!current.length) return;
    const content = current.map((block) => block.text).join("\n\n");
    if (content.length >= 80) chunks.push({ content, heading: current.at(-1)?.heading, sectionPath: current.at(-1)?.sectionPath, pageStart: current.find((block) => block.page !== undefined)?.page, pageEnd: [...current].reverse().find((block) => block.page !== undefined)?.page });
    const tail = content.slice(-overlap).trim();
    const last = current.at(-1);
    current = tail && last ? [{ ...last, text: tail }] : [];
  };
  for (const block of expanded) {
    if (current.length && current.at(-1)?.sectionPath !== block.sectionPath) {
      finishChunk();
      current = [];
    }
    const size = current.reduce((total, item) => total + item.text.length + 2, 0);
    if (current.length && size + block.text.length > target) finishChunk();
    current.push(block);
  }
  finishChunk();
  return chunks;
}
