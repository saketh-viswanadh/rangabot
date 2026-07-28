export function codeLanguage(className?: string) {
  return /language-([^\s]+)/.exec(className ?? "")?.[1];
}

export function isBlockCode(children: string, language?: string) {
  return Boolean(language || children.includes("\n"));
}
