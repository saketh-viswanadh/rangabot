"use client";

import { useMemo, useState } from "react";
import hljs from "highlight.js/lib/common";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeLanguage, isBlockCode } from "@/lib/markdown";
import { downloadLocalApiFile } from "@/lib/local-api-client";

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  }, [code, language]);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  }

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language || "code"}</span>
        <button type="button" onClick={() => void copyCode()}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </div>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  const [downloadMessage, setDownloadMessage] = useState("");

  async function downloadLocalLink(path: string) {
    setDownloadMessage("Preparing the local file…");
    try {
      const segment = path.split("?", 1)[0]?.split("/").filter(Boolean).at(-1) ?? "file";
      const filename = /^\/api\/artifacts\/word\/[^/]+\/document(?:\?|$)/.test(path)
        ? "rangabot-document.docx"
        : `rangabot-${segment}`;
      await downloadLocalApiFile(path, filename);
      setDownloadMessage("Local file ready.");
    } catch (error) {
      setDownloadMessage(error instanceof Error ? error.message : "The local file could not be downloaded.");
    }
  }

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const text = String(children).replace(/\n$/, "");
            const language = codeLanguage(className);
            return isBlockCode(String(children), language)
              ? <CodeBlock code={text} language={language} />
              : <code className={className} {...props}>{children}</code>;
          },
          a({ href, children, ...props }) {
            const external = href?.startsWith("http://") || href?.startsWith("https://");
            if (href?.startsWith("/api/")) {
              return <button type="button" className="markdown-download-link" onClick={() => void downloadLocalLink(href)}>{children}</button>;
            }
            return <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} {...props}>{children}</a>;
          },
          img({ alt }) {
            return <span className="blocked-markdown-image" role="note">Image blocked{alt ? `: ${alt}` : ""}</span>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
      {downloadMessage && <span className="sr-only" role="status" aria-live="polite">{downloadMessage}</span>}
    </div>
  );
}
