import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-xl font-bold mb-2 mt-3">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-lg font-bold mb-2 mt-3">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mb-1 mt-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-semibold mb-1 mt-2">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 underline hover:text-blue-300"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ className, children }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={`${className ?? ""} text-sm font-mono`}>
          {children}
        </code>
      );
    }
    return (
      <code className="bg-zinc-700 rounded px-1 py-0.5 text-sm font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-zinc-800 rounded p-3 text-sm font-mono overflow-x-auto mb-2">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2">
      <table className="min-w-full border border-zinc-600 text-sm">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-zinc-700">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border border-zinc-600 px-3 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-zinc-600 px-3 py-1.5">{children}</td>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-500 pl-3 italic text-zinc-400 mb-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-zinc-600 my-3" />,
};

export function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
