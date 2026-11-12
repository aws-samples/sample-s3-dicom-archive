import React from 'react';
import ReactMarkdown from 'react-markdown';

/**
 * Renders CHANGELOG.md with explicit styles: the app's CSS reset removes list
 * bullets, heading sizes and rule lines, so they are set here instead.
 * Colors use currentColor so every theme (light or dark) stays readable.
 */
const styled = (Tag: any, style: React.CSSProperties) =>
  // react-markdown passes its AST node as `node`; keep it off the DOM element.
  ({ node, ...rest }: any) => <Tag style={style} {...rest} />;

const components = {
  h1: styled('h1', { fontSize: '22px', fontWeight: 700, margin: '0 0 16px' }),
  h2: styled('h2', { fontSize: '18px', fontWeight: 700, margin: '8px 0 12px' }),
  h3: styled('h3', { fontSize: '15px', fontWeight: 600, margin: '16px 0 6px' }),
  ul: styled('ul', { listStyleType: 'disc', paddingLeft: '24px', margin: '0 0 8px' }),
  ol: styled('ol', { listStyleType: 'decimal', paddingLeft: '24px', margin: '0 0 8px' }),
  li: styled('li', { display: 'list-item', margin: '2px 0' }),
  p: styled('p', { margin: '0 0 8px' }),
  strong: styled('strong', { fontWeight: 700 }),
  hr: styled('hr', { border: 0, borderTop: '1px solid currentColor', opacity: 0.25, margin: '24px 0' }),
  code: styled('code', {
    fontFamily: 'monospace', fontSize: '13px', padding: '0 4px', borderRadius: '3px',
    background: 'color-mix(in srgb, currentColor 12%, transparent)',
  }),
};

export default function ChangelogMarkdown({ children }: { children: string }) {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
}
