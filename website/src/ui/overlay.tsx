import React, { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn, fire, textOf } from './util';

const SIZE: Record<string, string> = {
  small: 'max-w-[420px]', medium: 'max-w-[600px]', large: 'max-w-[880px]', 'x-large': 'max-w-[1120px]', max: 'max-w-[min(1400px,calc(100vw-48px))]',
};

export function Modal({ visible, onDismiss, header, footer, size = 'medium', closeAriaLabel, children, disableContentPaddings }: {
  visible?: boolean; onDismiss?: (e: any) => void; header?: React.ReactNode; footer?: React.ReactNode; size?: string;
  closeAriaLabel?: string; children?: React.ReactNode; disableContentPaddings?: boolean;
}) {
  return (
    <Dialog.Root open={!!visible} onOpenChange={(o) => { if (!o) fire(onDismiss, { reason: 'closeButton' }); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] animate-[ui-fade-in_.15s_ease-out]" />
        <Dialog.Content aria-describedby={undefined}
          onPointerDownOutside={(e) => { const t = e.target as HTMLElement; if (t?.closest?.('[data-radix-popper-content-wrapper]')) e.preventDefault(); }}
          className={cn('fixed left-1/2 top-1/2 z-40 flex max-h-[calc(100vh-48px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border bg-card text-card-foreground shadow-2xl outline-none animate-[ui-zoom-in_.16s_ease-out]', SIZE[size] || SIZE.medium)}>
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
            <Dialog.Title asChild>
              <div className="min-w-0 text-[17px] font-semibold tracking-tight">{header}</div>
            </Dialog.Title>
            <Dialog.Close aria-label={closeAriaLabel || 'Close'} className="-mr-2 -mt-1 rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className={cn('ui-scroll min-h-0 flex-1 overflow-y-auto', !disableContentPaddings && 'px-6 pb-5 pt-1')}>{children}</div>
          {footer && <div className="rounded-b-2xl border-t bg-muted/40 px-6 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Tabs({ tabs = [], activeTabId, onChange, variant, ariaLabel }: {
  tabs?: Array<{ id: string; label: React.ReactNode; content?: React.ReactNode; disabled?: boolean; href?: string }>;
  activeTabId?: string; onChange?: (e: any) => void; variant?: string; ariaLabel?: string;
}) {
  const [inner, setInner] = useState(tabs[0]?.id);
  const active = activeTabId ?? inner;
  const current = tabs.find(t => t.id === active) || tabs[0];
  const boxed = variant === 'container';
  return (
    <div className={cn(boxed && 'rounded-xl border bg-card')}>
      <div role="tablist" aria-label={ariaLabel} className={cn('flex gap-1 overflow-x-auto border-b', boxed ? 'px-3' : '')}>
        {tabs.map(t => {
          const on = t.id === current?.id;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={on} disabled={t.disabled}
              aria-label={textOf(t.label) || t.id}
              onClick={() => { if (activeTabId === undefined) setInner(t.id); fire(onChange, { activeTabId: t.id, activeTabHref: t.href }); }}
              className={cn('relative -mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors disabled:opacity-40',
                on ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className={cn('pt-4', boxed && 'px-5 pb-5')}>{current?.content}</div>
    </div>
  );
}
