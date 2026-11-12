import React, { useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight, CheckCircle2, XCircle, AlertTriangle, Info, Loader2, Clock, CircleSlash, X } from 'lucide-react';
import { cn, fire, KitIcon, SPACE } from './util';

type Spacing = string | { top?: string; bottom?: string; left?: string; right?: string; horizontal?: string; vertical?: string };
function spacing(prefix: 'padding' | 'margin', v?: Spacing): React.CSSProperties {
  if (!v) return {};
  const px = (s?: string) => (s ? SPACE[s] ?? 0 : undefined);
  if (typeof v === 'string') return { [prefix]: px(v) };
  const out: any = {};
  const set = (side: string, s?: string) => { if (s) out[prefix + side] = px(s); };
  set('Top', v.top ?? v.vertical); set('Bottom', v.bottom ?? v.vertical);
  set('Left', v.left ?? v.horizontal); set('Right', v.right ?? v.horizontal);
  return out;
}

const BOX_VARIANT: Record<string, { tag: string; cls: string }> = {
  h1: { tag: 'h1', cls: 'text-2xl font-semibold tracking-tight' },
  h2: { tag: 'h2', cls: 'text-xl font-semibold tracking-tight' },
  h3: { tag: 'h3', cls: 'text-base font-semibold' },
  h4: { tag: 'h4', cls: 'text-sm font-semibold' },
  h5: { tag: 'h5', cls: 'text-sm font-semibold' },
  p: { tag: 'p', cls: '' },
  small: { tag: 'small', cls: 'text-xs text-muted-foreground' },
  strong: { tag: 'strong', cls: 'font-semibold' },
  code: { tag: 'code', cls: 'font-mono text-xs bg-muted rounded px-1 py-0.5' },
  pre: { tag: 'pre', cls: 'font-mono text-xs bg-muted rounded-md p-3 overflow-auto' },
  span: { tag: 'span', cls: '' },
  samp: { tag: 'samp', cls: 'font-mono' },
  'awsui-key-label': { tag: 'div', cls: 'text-xs font-medium text-muted-foreground mb-0.5' },
  'awsui-value-large': { tag: 'span', cls: 'text-3xl font-semibold tracking-tight' },
};
const BOX_COLOR: Record<string, string> = {
  inherit: '', 'text-body-secondary': 'text-muted-foreground', 'text-status-inactive': 'text-muted-foreground',
  'text-status-info': 'text-info', 'text-status-error': 'text-destructive', 'text-status-warning': 'text-warning',
  'text-status-success': 'text-success', 'text-label': 'text-muted-foreground',
};
const BOX_FONT: Record<string, string> = {
  'body-s': 'text-xs', 'body-m': 'text-sm', 'heading-xs': 'text-sm font-semibold', 'heading-s': 'text-base font-semibold',
  'heading-m': 'text-lg font-semibold', 'heading-l': 'text-xl font-semibold', 'heading-xl': 'text-2xl font-semibold',
  'display-l': 'text-4xl font-bold',
};

export interface BoxProps {
  variant?: string; color?: string; fontSize?: string; fontWeight?: string; padding?: Spacing; margin?: Spacing;
  float?: 'left' | 'right'; textAlign?: 'left' | 'center' | 'right'; display?: string; children?: React.ReactNode;
  className?: string; id?: string; tagOverride?: string;
}
export function Box({ variant, color, fontSize, fontWeight, padding, margin, float, textAlign, display, children, className, id, tagOverride }: BoxProps) {
  const v = BOX_VARIANT[variant || ''] || { tag: 'div', cls: '' };
  const Tag: any = tagOverride || v.tag;
  return (
    <Tag id={id}
      className={cn(v.cls, color && BOX_COLOR[color], fontSize && BOX_FONT[fontSize],
        fontWeight === 'bold' || fontWeight === 'heavy' ? 'font-semibold' : fontWeight === 'light' ? 'font-light' : '',
        variant?.startsWith('h') && 'm-0', variant === 'p' && 'm-0', className)}
      style={{ ...spacing('padding', padding), ...spacing('margin', margin), float, textAlign, display: display === 'inline' ? 'inline' : display === 'block' ? 'block' : display === 'inline-block' ? 'inline-block' : display === 'none' ? 'none' : undefined }}>
      {children}
    </Tag>
  );
}

export function SpaceBetween({ size = 'm', direction = 'vertical', alignItems, children, className }: {
  size?: string; direction?: 'vertical' | 'horizontal'; alignItems?: 'center' | 'start' | 'end'; children?: React.ReactNode; className?: string;
}) {
  const items = React.Children.toArray(children).filter(c => c !== null && c !== undefined && (c as any) !== false && c !== '');
  return (
    <div data-hsb={direction === 'horizontal' ? '' : undefined} className={cn('flex', direction === 'horizontal' ? 'flex-row flex-wrap' : 'flex-col',
      alignItems === 'center' && 'items-center', alignItems === 'start' && 'items-start', alignItems === 'end' && 'items-end', className)}
      style={{ gap: SPACE[size] ?? 16 }}>
      {items}
    </div>
  );
}

export function Header({ variant = 'h2', counter, description, actions, info, children, headingTagOverride }: {
  variant?: 'h1' | 'h2' | 'h3' | 'awsui-h1-sticky'; counter?: string; description?: React.ReactNode; actions?: React.ReactNode;
  info?: React.ReactNode; children?: React.ReactNode; headingTagOverride?: string;
}) {
  const Tag: any = headingTagOverride || (variant === 'awsui-h1-sticky' ? 'h1' : variant);
  const hasTitle = React.Children.toArray(children).some(c => c !== null && c !== false && c !== '');
  const size = variant === 'h1' || variant === 'awsui-h1-sticky' ? 'text-[22px] font-semibold tracking-tight'
    : variant === 'h2' ? 'text-[17px] font-semibold tracking-tight' : 'text-base font-semibold';
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <Tag className={cn('m-0 flex items-baseline gap-2 text-foreground', size)}>
          {hasTitle && <span>{children}</span>}
          {counter && (hasTitle
            ? <span className="text-muted-foreground font-normal text-[0.85em] tabular-nums">{counter}</span>
            : <span className="text-sm font-medium text-muted-foreground tabular-nums">{String(counter).replace(/^\((.*)\)$/, '$1')} total</span>)}
          {info && <span className="text-sm font-normal">{info}</span>}
        </Tag>
        {description && <div className="mt-1 text-sm text-muted-foreground leading-snug">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 [&>[data-hsb]]:flex-nowrap">{actions}</div>}
    </div>
  );
}

export function Container({ header, footer, children, variant, disableContentPaddings, fitHeight, className }: {
  header?: React.ReactNode; footer?: React.ReactNode; children?: React.ReactNode; variant?: string;
  disableContentPaddings?: boolean; fitHeight?: boolean; className?: string;
}) {
  if (variant === 'stacked' || variant === 'embedded') {
    return <div className={className}>{header && <div className="mb-3">{header}</div>}{children}</div>;
  }
  return (
    <section className={cn('rounded-xl border bg-card text-card-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]', fitHeight && 'h-full', className)}>
      {header && <div className="px-5 pt-4 pb-3">{header}</div>}
      {children !== undefined && children !== null && (
        <div className={cn(!disableContentPaddings && (header ? 'px-5 pb-5' : 'p-5'))}>{children}</div>
      )}
      {footer && <div className="border-t px-5 py-3">{footer}</div>}
    </section>
  );
}

export function ContentLayout({ header, children }: { header?: React.ReactNode; children?: React.ReactNode }) {
  return <div className="flex flex-col gap-5">{header && <div>{header}</div>}{children}</div>;
}

export function ColumnLayout({ columns = 1, variant, borders, children, minColumnWidth }: {
  columns?: number; variant?: 'default' | 'text-grid'; borders?: string; children?: React.ReactNode; minColumnWidth?: number;
}) {
  const items = React.Children.toArray(children).filter(Boolean);
  const cols = Math.max(1, Math.min(4, columns));
  const grid = cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 md:grid-cols-2' : cols === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-2 lg:grid-cols-4';
  return (
    <div className={cn('grid gap-x-6 gap-y-4', grid)} style={minColumnWidth ? { gridTemplateColumns: `repeat(auto-fit, minmax(${minColumnWidth}px, 1fr))` } : undefined}>
      {items.map((c, i) => (
        <div key={i} className={cn('min-w-0', (variant === 'text-grid' || borders === 'vertical' || borders === 'all') && i % cols !== 0 && 'md:border-l md:pl-6')}>{c}</div>
      ))}
    </div>
  );
}

// Cloudscape breakpoints: default (<688), xs 688, s 912, m 1120, l 1320, xl 1840.
const BP = ['default', 'xs', 's', 'm', 'l', 'xl'] as const;
const BP_CLASS = '[grid-column:var(--g0)] min-[688px]:[grid-column:var(--g1)] min-[912px]:[grid-column:var(--g2)] min-[1120px]:[grid-column:var(--g3)] min-[1320px]:[grid-column:var(--g4)] min-[1840px]:[grid-column:var(--g5)]';
function cascade(v: any, fallback: number): number[] {
  const out: number[] = []; let cur = fallback;
  for (const b of BP) { const x = typeof v === 'number' ? v : v?.[b]; if (typeof x === 'number') cur = x; out.push(cur); }
  return out;
}
export function Grid({ gridDefinition = [], children, disableGutters }: {
  gridDefinition?: Array<{ colspan?: number | Record<string, number>; offset?: number | Record<string, number> }>; children?: React.ReactNode; disableGutters?: boolean;
}) {
  const items = React.Children.toArray(children);
  return (
    <div className={cn('grid grid-cols-12', !disableGutters && 'gap-x-5 gap-y-4')}>
      {items.map((c, i) => {
        const d = gridDefinition[i] || {};
        const spans = cascade(d.colspan, 12); const offs = cascade(d.offset, 0);
        const style: any = {};
        spans.forEach((n, k) => { const o = offs[k]; style[`--g${k}`] = o ? `${o + 1} / span ${n}` : `span ${n} / span ${n}`; });
        return <div key={i} className={cn('min-w-0', BP_CLASS)} style={style}>{c}</div>;
      })}
    </div>
  );
}

const BADGE: Record<string, string> = {
  grey: 'bg-secondary text-secondary-foreground border-border',
  blue: 'bg-primary/12 text-primary border-primary/25',
  red: 'bg-destructive/12 text-destructive border-destructive/25',
  green: 'bg-success/12 text-success border-success/25',
  'severity-high': 'bg-destructive/12 text-destructive border-destructive/25',
  'severity-medium': 'bg-warning/15 text-warning border-warning/30',
  'severity-low': 'bg-info/12 text-info border-info/25',
};
export function Badge({ color = 'grey', children }: { color?: string; children?: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-px text-xs font-medium leading-[18px]', BADGE[color] || BADGE.grey)}>
      {children}
    </span>
  );
}

const STATUS: Record<string, { icon: React.ElementType; cls: string; spin?: boolean }> = {
  success: { icon: CheckCircle2, cls: 'text-success' },
  error: { icon: XCircle, cls: 'text-destructive' },
  warning: { icon: AlertTriangle, cls: 'text-warning' },
  info: { icon: Info, cls: 'text-info' },
  pending: { icon: Clock, cls: 'text-muted-foreground' },
  'in-progress': { icon: Loader2, cls: 'text-info', spin: true },
  loading: { icon: Loader2, cls: 'text-muted-foreground', spin: true },
  stopped: { icon: CircleSlash, cls: 'text-muted-foreground' },
};
export function StatusIndicator({ type = 'success', children, wrapText, colorOverride }: { type?: string; children?: React.ReactNode; wrapText?: boolean; colorOverride?: string }) {
  const s = STATUS[type] || STATUS.info;
  const I = s.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', !wrapText && 'whitespace-nowrap', s.cls)}>
      <I size={15} strokeWidth={2.2} className={cn('shrink-0', s.spin && 'animate-spin')} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

export function Spinner({ size = 'normal' }: { size?: 'normal' | 'big' | 'large' }) {
  const px = size === 'large' ? 28 : size === 'big' ? 22 : 16;
  return <Loader2 size={px} className="inline-block animate-spin text-muted-foreground align-[-3px]" aria-label="Loading" />;
}

export function Icon({ name, size = 'normal', variant }: { name?: string; size?: string; variant?: string }) {
  const px = size === 'large' ? 22 : size === 'medium' ? 18 : size === 'big' ? 26 : 16;
  return <KitIcon name={name} size={px} className={cn('inline-block align-[-3px]', variant === 'error' && 'text-destructive', variant === 'warning' && 'text-warning', variant === 'success' && 'text-success', variant === 'subtle' && 'text-muted-foreground')} />;
}

export function Link({ href, external, onFollow, children, variant, fontSize, color }: {
  href?: string; external?: boolean; onFollow?: (e: any) => void; children?: React.ReactNode; variant?: string; fontSize?: string; color?: string;
}) {
  return (
    <a href={href || '#'} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}
      onClick={(e) => { if (onFollow) { const ev = fire(onFollow, { href, external }, e); if (!href || ev.defaultPrevented) e.preventDefault(); } else if (!href) e.preventDefault(); }}
      className={cn('font-medium text-primary underline-offset-4 hover:underline cursor-pointer', fontSize && BOX_FONT[fontSize], color === 'inverted' && 'text-white')}>
      {children}{external && <KitIcon name="external" size={12} className="ml-1 inline align-[-1px]" />}
    </a>
  );
}

const ALERT: Record<string, { icon: React.ElementType; cls: string }> = {
  info: { icon: Info, cls: 'border-info/30 bg-info/8 [&_.ai]:text-info' },
  success: { icon: CheckCircle2, cls: 'border-success/30 bg-success/8 [&_.ai]:text-success' },
  warning: { icon: AlertTriangle, cls: 'border-warning/35 bg-warning/10 [&_.ai]:text-warning' },
  error: { icon: XCircle, cls: 'border-destructive/30 bg-destructive/8 [&_.ai]:text-destructive' },
};
export function Alert({ type = 'info', header, children, dismissible, onDismiss, action, statusIconAriaLabel }: {
  type?: string; header?: React.ReactNode; children?: React.ReactNode; dismissible?: boolean; onDismiss?: (e: any) => void;
  action?: React.ReactNode; statusIconAriaLabel?: string; visible?: boolean;
}) {
  const a = ALERT[type] || ALERT.info;
  const I = a.icon;
  return (
    <div role={type === 'error' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm animate-[ui-slide-down_.15s_ease-out]', a.cls)}>
      <I size={18} className="ai mt-px shrink-0" aria-label={statusIconAriaLabel || type} />
      <div className="min-w-0 flex-1">
        {header && <div className="font-semibold mb-0.5">{header}</div>}
        <div className="break-words text-foreground/90">{children}</div>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {dismissible && (
        <button type="button" onClick={(e) => fire(onDismiss, {}, e)} aria-label="Dismiss"
          className="shrink-0 self-start rounded-md p-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function Flashbar({ items = [] }: { items?: Array<any>; stackItems?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => (
        <Alert key={it.id || i} type={it.type === 'in-progress' ? 'info' : it.type} header={it.header} dismissible={it.dismissible}
          onDismiss={it.onDismiss} action={it.action || (it.buttonText ? <button className="text-sm font-medium underline" onClick={it.onButtonClick}>{it.buttonText}</button> : undefined)}>
          {it.loading && <Spinner />} {it.content}
        </Alert>
      ))}
    </div>
  );
}

export function ProgressBar({ value = 0, label, description, additionalInfo, status = 'in-progress', resultText, variant }: {
  value?: number; label?: React.ReactNode; description?: React.ReactNode; additionalInfo?: React.ReactNode;
  status?: 'in-progress' | 'success' | 'error'; resultText?: React.ReactNode; variant?: string;
}) {
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="w-full">
      {label && <div className="text-sm font-medium mb-1">{label}</div>}
      {description && <div className="text-xs text-muted-foreground mb-1.5">{description}</div>}
      {status === 'in-progress' ? (
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label={typeof label === 'string' ? label : 'Progress'} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${v}%` }} />
          </div>
          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{Math.round(v)}%</span>
        </div>
      ) : (
        <StatusIndicator type={status === 'success' ? 'success' : 'error'}>{resultText}</StatusIndicator>
      )}
      {additionalInfo && <div className="mt-1 text-xs text-muted-foreground">{additionalInfo}</div>}
    </div>
  );
}

export function KeyValuePairs({ columns = 1, items = [] }: { columns?: number; items?: Array<any> }) {
  const flat: any[] = [];
  for (const it of items) {
    if (it && it.type === 'group') flat.push(...(it.items || []));
    else if (it) flat.push(it);
  }
  const cols = Math.max(1, Math.min(4, columns));
  return (
    <dl className={cn('m-0 grid gap-x-8 gap-y-4', cols === 1 ? 'grid-cols-1' : cols === 2 ? 'grid-cols-1 sm:grid-cols-2' : cols === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2 lg:grid-cols-4')}>
      {flat.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-muted-foreground">{it.label}{it.info && <span className="ml-1">{it.info}</span>}</dt>
          <dd className="m-0 mt-0.5 break-words text-sm">{it.value ?? '-'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExpandableSection({ headerText, header, defaultExpanded, expanded, onChange, variant, children, headerDescription, headerActions }: {
  headerText?: React.ReactNode; header?: React.ReactNode; defaultExpanded?: boolean; expanded?: boolean; onChange?: (e: any) => void;
  variant?: string; children?: React.ReactNode; headerDescription?: React.ReactNode; headerActions?: React.ReactNode;
}) {
  const [inner, setInner] = useState(!!defaultExpanded);
  const open = expanded ?? inner;
  const setOpen = (o: boolean) => { if (expanded === undefined) setInner(o); fire(onChange, { expanded: o }); };
  const boxed = variant === 'container';
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn(boxed && 'rounded-xl border bg-card')}>
      <div className={cn('flex items-center justify-between gap-3', boxed && 'px-5 py-3')}>
        <Collapsible.Trigger className="group flex items-center gap-1.5 bg-transparent text-left text-sm font-semibold text-foreground hover:text-primary">
          <ChevronRight size={16} className="transition-transform group-data-[state=open]:rotate-90" />
          {headerText || header}
        </Collapsible.Trigger>
        {headerActions}
      </div>
      {headerDescription && <div className={cn('text-xs text-muted-foreground', boxed ? 'px-5 -mt-2 pb-2' : 'ml-6')}>{headerDescription}</div>}
      <Collapsible.Content className={cn('pt-3', boxed && 'px-5 pb-5')}>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
