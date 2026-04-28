import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import "./MarkdownRenderer.css";

function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-language">{language || "text"}</span>
        <button
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy code"}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language || "text"}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: "0 0 6px 6px",
          fontSize: "13px",
          background: "rgba(0, 0, 0, 0.4)",
        }}
        codeTagProps={{
          style: {
            fontFamily: "var(--font-mono)",
          },
        }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

function InlineCode({ children }) {
  return <code className="md-inline-code">{children}</code>;
}

export default function MarkdownRenderer({ content }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, inline, className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const language = match ? match[1] : "";
            const codeString = String(children).replace(/\n$/, "");

            if (!inline && (match || codeString.includes("\n"))) {
              return <CodeBlock language={language}>{codeString}</CodeBlock>;
            }

            return <InlineCode {...props}>{children}</InlineCode>;
          },
          // Custom link handling
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          // Better table styling
          table({ children }) {
            return (
              <div className="md-table-wrapper">
                <table className="md-table">{children}</table>
              </div>
            );
          },
          // Better blockquote
          blockquote({ children }) {
            return <blockquote className="md-blockquote">{children}</blockquote>;
          },
          // Better lists
          ul({ children }) {
            return <ul className="md-list md-ul">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="md-list md-ol">{children}</ol>;
          },
          // Better headings
          h1({ children }) {
            return <h1 className="md-heading md-h1">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="md-heading md-h2">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="md-heading md-h3">{children}</h3>;
          },
          h4({ children }) {
            return <h4 className="md-heading md-h4">{children}</h4>;
          },
          // Horizontal rule
          hr() {
            return <hr className="md-hr" />;
          },
          // Paragraphs
          p({ children }) {
            return <p className="md-paragraph">{children}</p>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
