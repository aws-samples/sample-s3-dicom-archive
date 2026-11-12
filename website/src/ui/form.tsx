import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { Check, ChevronDown, Loader2, Minus, Search, X, Calendar, ExternalLink } from 'lucide-react';
import { cn, fire, KitIcon, textOf } from './util';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer';
const BTN: Record<string, string> = {
  primary: 'h-8.5 px-3.5 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 active:bg-primary/85',
  normal: 'h-8.5 px-3.5 border bg-card text-foreground shadow-[0_1px_1px_0_rgb(0_0_0/0.03)] hover:bg-secondary active:bg-secondary/80',
  link: 'h-8.5 px-3 text-primary hover:bg-primary/8',
  icon: 'size-8.5 text-muted-foreground hover:bg-secondary hover:text-foreground',
  'inline-icon': 'size-6 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground',
  'inline-link': 'h-auto p-0 text-primary hover:underline underline-offset-4',
};

export interface ButtonProps {
  variant?: string; onClick?: (e: any) => void; disabled?: boolean; loading?: boolean; iconName?: string; iconAlign?: 'left' | 'right';
  ariaLabel?: string; formAction?: 'submit' | 'none'; href?: string; target?: string; external?: boolean; children?: React.ReactNode;
  fullWidth?: boolean; wrapText?: boolean; loadingText?: string; iconUrl?: string; download?: boolean | string; className?: string;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'normal', onClick, disabled, loading, iconName, iconAlign = 'left', ariaLabel, formAction, href, target, external, children, fullWidth, wrapText, download, className }, ref) {
  const icon = loading ? <Loader2 size={15} className="animate-spin" /> : iconName ? <KitIcon name={iconName} size={variant === 'inline-icon' ? 15 : 16} /> : null;
  const content = (
    <>
      {iconAlign === 'left' && icon}
      {children && <span className={cn(wrapText && 'whitespace-normal text-left')}>{children}</span>}
      {iconAlign === 'right' && icon}
      {external && <ExternalLink size={13} className="opacity-70" />}
    </>
  );
  const cls = cn(BTN_BASE, BTN[variant] || BTN.normal, fullWidth && 'w-full', className);
  if (href) {
    return (
      <a href={disabled ? undefined : href} target={external ? '_blank' : target} rel={external ? 'noreferrer' : undefined}
        download={download as any} aria-label={ariaLabel} aria-disabled={disabled} className={cn(cls, disabled && 'pointer-events-none opacity-50')}
        onClick={(e) => { if (onClick) fire(onClick, {}, e); }}>
        {content}
      </a>
    );
  }
  return (
    <button ref={ref} type={formAction === 'submit' ? 'submit' : 'button'} disabled={disabled || loading} aria-label={ariaLabel || (!children ? iconName : undefined)}
      className={cls} onClick={(e) => { if (formAction !== 'submit') e.preventDefault(); fire(onClick, {}, e); }}>
      {content}
    </button>
  );
});

export function ButtonDropdown({ items = [], onItemClick, disabled, children, variant = 'normal', ariaLabel, loading, expandToViewport }: {
  items?: Array<any>; onItemClick?: (e: any) => void; disabled?: boolean; children?: React.ReactNode; variant?: string;
  ariaLabel?: string; loading?: boolean; expandToViewport?: boolean;
}) {
  const renderItems = (list: any[]) => list.map((it, i) => it.items ? (
    <DropdownMenu.Group key={it.id || i}>
      {it.text && <DropdownMenu.Label className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{it.text}</DropdownMenu.Label>}
      {renderItems(it.items)}
    </DropdownMenu.Group>
  ) : (
    <DropdownMenu.Item key={it.id || i} disabled={it.disabled}
      onSelect={() => { if (it.href) window.open(it.href, it.external ? '_blank' : '_self'); fire(onItemClick, { id: it.id, href: it.href, external: it.external }); }}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-secondary">
      {it.iconName && <KitIcon name={it.iconName} size={15} />}
      <span className="flex-1">{it.text}</span>
      {it.description && <span className="text-xs text-muted-foreground">{it.description}</span>}
    </DropdownMenu.Item>
  ));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled || loading}>
        <button type="button" aria-label={ariaLabel} className={cn(BTN_BASE, BTN[variant === 'primary' ? 'primary' : variant === 'icon' ? 'icon' : 'normal'])}>
          {loading && <Loader2 size={15} className="animate-spin" />}
          {children}
          {variant !== 'icon' ? <ChevronDown size={15} className="opacity-70" /> : <KitIcon name="ellipsis" />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg animate-[ui-slide-down_.12s_ease-out]">
          {renderItems(items)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export function FormField({ label, description, constraintText, errorText, stretch, secondaryControl, info, children, warningText }: {
  label?: React.ReactNode; description?: React.ReactNode; constraintText?: React.ReactNode; errorText?: React.ReactNode;
  stretch?: boolean; secondaryControl?: React.ReactNode; info?: React.ReactNode; children?: React.ReactNode; warningText?: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col', !stretch && 'max-w-full')}>
      {label && (
        <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
          {label}{info && <span className="font-normal">{info}</span>}
        </label>
      )}
      {description && <div className="mb-1.5 -mt-0.5 text-xs leading-snug text-muted-foreground">{description}</div>}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {secondaryControl && <div className="shrink-0">{secondaryControl}</div>}
      </div>
      {errorText && <div className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive"><X size={13} />{errorText}</div>}
      {warningText && <div className="mt-1 text-xs font-medium text-warning">{warningText}</div>}
      {constraintText && <div className="mt-1 text-xs text-muted-foreground">{constraintText}</div>}
    </div>
  );
}

export function Form({ header, actions, errorText, children, secondaryActions, variant }: {
  header?: React.ReactNode; actions?: React.ReactNode; errorText?: React.ReactNode; children?: React.ReactNode; secondaryActions?: React.ReactNode; variant?: string;
}) {
  return (
    <div className="flex flex-col gap-5">
      {header && <div>{header}</div>}
      {children}
      {errorText && <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-sm text-destructive">{errorText}</div>}
      {(actions || secondaryActions) && (
        <div className="flex items-center justify-between gap-2">
          <div>{secondaryActions}</div>
          <div>{actions}</div>
        </div>
      )}
    </div>
  );
}

const FIELD = 'h-8.5 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground shadow-[inset_0_1px_1px_0_rgb(0_0_0/0.03)] outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground read-only:bg-muted/60';

function keyDetail(e: React.KeyboardEvent) {
  return { key: e.key, keyCode: e.keyCode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: (e.nativeEvent as any).isComposing };
}

export const Input = React.forwardRef<HTMLInputElement, any>(function Input(
  { value, onChange, placeholder, type = 'text', disabled, onKeyDown, onKeyUp, autoFocus, inputMode, invalid, readOnly, onBlur, onFocus, ariaLabel, step, autoComplete, name, spellcheck, className }, ref) {
  const isSearch = type === 'search';
  return (
    <div className="relative">
      {isSearch && <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />}
      <input ref={ref} value={value ?? ''} type={isSearch ? 'text' : type} placeholder={placeholder} disabled={disabled} readOnly={readOnly}
        autoFocus={autoFocus} inputMode={inputMode} aria-label={ariaLabel} aria-invalid={invalid || undefined} step={step} name={name}
        autoComplete={autoComplete === false ? 'off' : typeof autoComplete === 'string' ? autoComplete : undefined} spellCheck={spellcheck}
        onChange={(e) => fire(onChange, { value: e.target.value }, e)}
        onKeyDown={(e) => fire(onKeyDown, keyDetail(e), e)} onKeyUp={(e) => fire(onKeyUp, keyDetail(e), e)}
        onBlur={(e) => fire(onBlur, {}, e)} onFocus={(e) => fire(onFocus, {}, e)}
        className={cn(FIELD, isSearch && 'pl-8', invalid && 'border-destructive focus:ring-destructive/20', className)} />
    </div>
  );
});

export function Textarea({ value, onChange, rows = 3, placeholder, onKeyDown, spellcheck, disabled, readOnly, invalid, ariaLabel, autoFocus }: any) {
  return (
    <textarea value={value ?? ''} rows={rows} placeholder={placeholder} spellCheck={spellcheck} disabled={disabled} readOnly={readOnly}
      aria-label={ariaLabel} autoFocus={autoFocus} aria-invalid={invalid || undefined}
      onChange={(e) => fire(onChange, { value: e.target.value }, e)} onKeyDown={(e) => fire(onKeyDown, keyDetail(e as any), e)}
      className={cn(FIELD, 'h-auto min-h-16 resize-y py-2 leading-relaxed', invalid && 'border-destructive')} />
  );
}

// ---------------------------------------------------------------------------
// Select / Multiselect / Autosuggest (one listbox implementation)
// ---------------------------------------------------------------------------

export interface KitOption { label?: string; value?: string; description?: string; disabled?: boolean; tags?: string[]; labelTag?: string; iconName?: string; options?: KitOption[]; filteringTags?: string[] }

function flatten(options: KitOption[] = []): Array<KitOption & { group?: string }> {
  const out: Array<KitOption & { group?: string }> = [];
  for (const o of options) {
    if (o && Array.isArray(o.options)) for (const c of o.options) out.push({ ...c, group: o.label });
    else if (o) out.push(o);
  }
  return out;
}
const optText = (o: KitOption) => `${o.label ?? o.value ?? ''} ${o.description ?? ''} ${(o.tags || []).join(' ')} ${(o.filteringTags || []).join(' ')} ${o.labelTag ?? ''}`.toLowerCase();

function OptionList({ options, isSelected, onPick, filter, multi, empty, statusType, loadingText, onClose }: {
  options: KitOption[]; isSelected: (o: KitOption) => boolean; onPick: (o: KitOption) => void; filter: boolean; multi?: boolean;
  empty?: React.ReactNode; statusType?: string; loadingText?: string; onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const flat = useMemo(() => flatten(options), [options]);
  const shown = useMemo(() => (q ? flat.filter(o => optText(o).includes(q.toLowerCase())) : flat), [flat, q]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setActive(Math.max(0, shown.findIndex(isSelected))); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o && !o.disabled) onPick(o); }
    else if (e.key === 'Escape') onClose();
  };
  let lastGroup: string | undefined;
  return (
    <div onKeyDown={onKey} className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] flex-col">
      {filter && (
        <div className="relative border-b p-1.5">
          <Search size={14} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Filter" aria-label="Filter options"
            className="h-8 w-full rounded-md bg-muted/60 pl-8 pr-2 text-sm outline-none focus:bg-muted" />
        </div>
      )}
      <div ref={listRef} role="listbox" aria-multiselectable={multi || undefined} tabIndex={filter ? -1 : 0} autoFocus={!filter}
        className="ui-scroll overflow-y-auto p-1 outline-none">
        {statusType === 'loading' && <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" />{loadingText || 'Loading'}</div>}
        {statusType !== 'loading' && !shown.length && <div className="px-2 py-2 text-sm text-muted-foreground">{q ? 'No matches' : empty || 'No options'}</div>}
        {shown.map((o, i) => {
          const sel = isSelected(o);
          const head = o.group && o.group !== lastGroup ? o.group : null;
          lastGroup = o.group;
          return (
            <React.Fragment key={`${o.value}-${i}`}>
              {head && <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{head}</div>}
              <div role="option" aria-selected={sel} aria-disabled={o.disabled} data-idx={i}
                onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => !o.disabled && onPick(o)}
                className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-secondary', o.disabled && 'cursor-not-allowed opacity-50')}>
                {multi
                  ? <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border', sel ? 'border-primary bg-primary text-primary-foreground' : 'border-input')}>{sel && <Check size={12} strokeWidth={3} />}</span>
                  : <Check size={15} className={cn('mt-0.5 shrink-0 text-primary', !sel && 'invisible')} />}
                {o.iconName && <KitIcon name={o.iconName} size={15} className="mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="truncate">{o.label ?? o.value}</span>{o.labelTag && <span className="ml-auto text-xs text-muted-foreground">{o.labelTag}</span>}</div>
                  {o.description && <div className="text-xs text-muted-foreground">{o.description}</div>}
                  {o.tags && o.tags.length > 0 && <div className="mt-0.5 flex flex-wrap gap-1">{o.tags.map(t => <span key={t} className="text-[11px] text-muted-foreground">{t}</span>)}</div>}
                </div>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function Trigger({ open, disabled, invalid, children, ariaLabel, placeholder, hasValue, ...rest }: any) {
  return (
    <button type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} {...rest}
      className={cn(FIELD, 'flex items-center gap-2 text-left', open && 'border-ring ring-3 ring-ring/20', invalid && 'border-destructive')}>
      <span className={cn('min-w-0 flex-1 truncate', !hasValue && 'text-muted-foreground')}>{hasValue ? children : placeholder || 'Choose an option'}</span>
      <ChevronDown size={15} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
    </button>
  );
}

const POP = 'z-50 w-[var(--radix-popover-trigger-width)] min-w-56 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg animate-[ui-slide-down_.12s_ease-out]';

export function Select({ selectedOption, onChange, options = [], placeholder, empty, disabled, filteringType, loadingText, statusType, invalid, ariaLabel, triggerVariant, expandToViewport, virtualScroll }: any) {
  const [open, setOpen] = useState(false);
  const sel = selectedOption;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Trigger open={open} disabled={disabled} invalid={invalid} ariaLabel={ariaLabel} placeholder={placeholder} hasValue={!!sel}>
          {sel && <span className="flex items-center gap-2">{sel.iconName && <KitIcon name={sel.iconName} size={15} />}{sel.label ?? sel.value}{sel.labelTag && <span className="text-xs text-muted-foreground">{sel.labelTag}</span>}</span>}
        </Trigger>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} collisionPadding={8} className={POP} onOpenAutoFocus={(e) => { if (filteringType && filteringType !== 'none') return; e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role=listbox]')?.focus(); }}>
          <OptionList options={options} filter={!!filteringType && filteringType !== 'none'} empty={empty} statusType={statusType} loadingText={loadingText}
            isSelected={(o) => !!sel && o.value === sel.value} onClose={() => setOpen(false)}
            onPick={(o) => { setOpen(false); const { group, ...clean } = o as any; fire(onChange, { selectedOption: clean }); }} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function Multiselect({ selectedOptions = [], onChange, options = [], placeholder, filteringType, empty, statusType, loadingText, tokenLimit, disabled, ariaLabel, hideTokens, deselectAriaLabel }: any) {
  const [open, setOpen] = useState(false);
  const has = (o: KitOption) => selectedOptions.some((s: KitOption) => s.value === o.value);
  const toggle = (o: KitOption) => {
    const { group, ...clean } = o as any;
    fire(onChange, { selectedOptions: has(o) ? selectedOptions.filter((s: KitOption) => s.value !== o.value) : [...selectedOptions, clean] });
  };
  const shown = tokenLimit != null ? selectedOptions.slice(0, tokenLimit) : selectedOptions;
  return (
    <div className="flex flex-col gap-2">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Trigger open={open} disabled={disabled} ariaLabel={ariaLabel} placeholder={placeholder} hasValue={selectedOptions.length > 0}>
            {selectedOptions.length === 1 ? (selectedOptions[0].label ?? selectedOptions[0].value) : `${selectedOptions.length} selected`}
          </Trigger>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={4} collisionPadding={8} className={POP}>
            <OptionList multi options={options} filter={!!filteringType && filteringType !== 'none'} empty={empty} statusType={statusType}
              loadingText={loadingText} isSelected={has} onPick={toggle} onClose={() => setOpen(false)} />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {!hideTokens && selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((o: KitOption) => (
            <span key={o.value} className="inline-flex items-center gap-1 rounded-md border bg-secondary py-0.5 pl-2 pr-1 text-xs font-medium">
              {o.label ?? o.value}
              <button type="button" aria-label={`Remove ${o.label ?? o.value}`} disabled={disabled} onClick={() => toggle(o)} className="rounded p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"><X size={12} /></button>
            </span>
          ))}
          {tokenLimit != null && selectedOptions.length > tokenLimit && <span className="self-center text-xs text-muted-foreground">+{selectedOptions.length - tokenLimit} more</span>}
        </div>
      )}
    </div>
  );
}

export function Autosuggest({ value, onChange, options = [], placeholder, enteredTextLabel, filteringType = 'auto', statusType, onSelect, disabled, ariaLabel, empty }: any) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const flat = flatten(options);
  const shown = filteringType === 'manual' || !value ? flat : flat.filter(o => optText(o).includes(String(value).toLowerCase()));
  const pick = (v: string) => { fire(onChange, { value: v }); fire(onSelect, { value: v }); setOpen(false); };
  return (
    <Popover.Root open={open && (shown.length > 0 || !!value)} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div>
          <input value={value ?? ''} placeholder={placeholder} disabled={disabled} aria-label={ariaLabel} role="combobox" aria-expanded={open}
            onChange={(e) => { fire(onChange, { value: e.target.value }); setOpen(true); setActive(-1); }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(shown.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(-1, a - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(active >= 0 && shown[active] ? String(shown[active].value) : value); }
              else if (e.key === 'Escape') setOpen(false);
            }}
            className={FIELD} />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} onOpenAutoFocus={e => e.preventDefault()} onInteractOutside={(e) => { if ((e.target as HTMLElement)?.getAttribute?.('role') === 'combobox') e.preventDefault(); }} className={POP}>
          <div role="listbox" className="ui-scroll max-h-72 overflow-y-auto p-1">
            {value && enteredTextLabel && !flat.some(o => o.value === value) && (
              <div role="option" onMouseDown={e => e.preventDefault()} onClick={() => pick(value)} className={cn('cursor-pointer rounded-md px-2 py-1.5 text-sm', active === -1 && 'bg-secondary')}>{enteredTextLabel(value)}</div>
            )}
            {statusType === 'loading' && <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</div>}
            {!shown.length && statusType !== 'loading' && !value && <div className="px-2 py-1.5 text-sm text-muted-foreground">{empty || 'No suggestions'}</div>}
            {shown.map((o, i) => (
              <div key={`${o.value}-${i}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(String(o.value))}
                className={cn('cursor-pointer rounded-md px-2 py-1.5 text-sm', i === active && 'bg-secondary')}>
                <div>{o.label ?? o.value}</div>{o.description && <div className="text-xs text-muted-foreground">{o.description}</div>}
              </div>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Checkbox / Toggle / RadioGroup / Tiles / SegmentedControl
// ---------------------------------------------------------------------------

export function Checkbox({ checked, onChange, disabled, indeterminate, children, description, ariaLabel }: any) {
  return (
    <label className={cn('inline-flex items-start gap-2 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <CheckboxPrimitive.Root checked={indeterminate ? 'indeterminate' : !!checked} disabled={disabled} aria-label={ariaLabel || textOf(children) || undefined}
        onCheckedChange={(v) => fire(onChange, { checked: v === true, indeterminate: false })}
        className="mt-[2px] flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input bg-card shadow-[inset_0_1px_1px_0_rgb(0_0_0/0.04)] data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary text-primary-foreground">
        <CheckboxPrimitive.Indicator>{indeterminate ? <Minus size={12} strokeWidth={3} /> : <Check size={12} strokeWidth={3} />}</CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {(children || description) && <span className="leading-snug">{children}{description && <span className="block text-xs text-muted-foreground">{description}</span>}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, children, description, ariaLabel }: any) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <SwitchPrimitive.Root checked={!!checked} disabled={disabled} aria-label={ariaLabel || textOf(children) || undefined} onCheckedChange={(v) => fire(onChange, { checked: v })}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-input transition-colors data-[state=checked]:bg-primary">
        <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </SwitchPrimitive.Root>
      {(children || description) && <span>{children}{description && <span className="block text-xs text-muted-foreground">{description}</span>}</span>}
    </label>
  );
}

export function RadioGroup({ value, onChange, items = [], ariaLabel, name }: any) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-2">
      {items.map((it: any) => (
        <label key={it.value} className={cn('flex items-start gap-2 text-sm', it.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
          <input type="radio" name={name} checked={value === it.value} disabled={it.disabled} onChange={() => fire(onChange, { value: it.value })}
            className="mt-[3px] size-4 shrink-0 accent-[var(--color-primary)]" />
          <span className="leading-snug">{it.label}{it.description && <span className="block text-xs text-muted-foreground">{it.description}</span>}</span>
        </label>
      ))}
    </div>
  );
}

export function Tiles({ value, onChange, items = [], columns, ariaLabel }: any) {
  const cols = columns || Math.min(items.length, 3);
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((it: any) => {
        const on = value === it.value;
        return (
          <button key={it.value} type="button" role="radio" aria-checked={on} disabled={it.disabled} onClick={() => fire(onChange, { value: it.value })}
            className={cn('rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50', on && 'border-primary ring-2 ring-primary/20 bg-primary/5', it.disabled && 'opacity-50')}>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className={cn('flex size-4 items-center justify-center rounded-full border', on ? 'border-primary' : 'border-input')}>{on && <span className="size-2 rounded-full bg-primary" />}</span>
              {it.label}
            </div>
            {it.description && <div className="mt-1 text-xs text-muted-foreground">{it.description}</div>}
            {it.image && <div className="mt-2">{it.image}</div>}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedControl({ selectedId, onChange, options = [], label }: any) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border bg-muted p-0.5">
      {options.map((o: any) => (
        <button key={o.id} type="button" disabled={o.disabled} aria-pressed={selectedId === o.id} onClick={() => fire(onChange, { selectedId: o.id })}
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors',
            selectedId === o.id ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground')}>
          {o.iconName && <KitIcon name={o.iconName} size={14} />}{o.text}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Value is YYYY-MM-DD, like Cloudscape. Pages also hand in YYYY/MM/DD. */
export function DatePicker({ value, onChange, placeholder, onBlur, disabled, readOnly, ariaLabel, isDateEnabled }: any) {
  const v = (value || '').replace(/\//g, '-');
  return (
    <div className="relative">
      <input type="date" value={v} disabled={disabled} readOnly={readOnly} aria-label={ariaLabel || placeholder}
        onChange={(e) => fire(onChange, { value: e.target.value })} onBlur={(e) => fire(onBlur, {}, e)}
        className={cn(FIELD, 'pr-2 [&::-webkit-calendar-picker-indicator]:opacity-60 dark:[&::-webkit-calendar-picker-indicator]:invert', !v && 'text-muted-foreground')} />
    </div>
  );
}

const UNIT_MS: Record<string, number> = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 };
function describeRange(v: any, placeholder?: string, i18n?: any) {
  if (!v) return placeholder || 'Filter by a date and time range';
  if (v.type === 'relative') return i18n?.formatRelativeRange ? i18n.formatRelativeRange(v) : `Last ${v.amount} ${v.unit}${v.amount === 1 ? '' : 's'}`;
  const f = (s: string) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  return `${f(v.startDate)} – ${f(v.endDate)}`;
}
export function DateRangePicker({ value, onChange, relativeOptions = [], i18nStrings, isValidRange, placeholder, disabled, rangeSelectorMode = 'default' }: any) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'relative' | 'absolute'>(value?.type === 'absolute' || rangeSelectorMode === 'absolute-only' ? 'absolute' : 'relative');
  const [start, setStart] = useState(value?.type === 'absolute' ? String(value.startDate).slice(0, 16) : '');
  const [end, setEnd] = useState(value?.type === 'absolute' ? String(value.endDate).slice(0, 16) : '');
  const [rel, setRel] = useState<any>(value?.type === 'relative' ? value : null);
  const [error, setError] = useState('');
  const apply = () => {
    const next = mode === 'relative' ? rel : (start && end ? { type: 'absolute', startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString() } : null);
    const check = isValidRange ? isValidRange(next) : { valid: true };
    if (!check.valid) { setError(check.errorMessage || 'Invalid range'); return; }
    setError(''); setOpen(false); fire(onChange, { value: next });
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" disabled={disabled} className={cn(FIELD, 'flex items-center gap-2 text-left', !value && 'text-muted-foreground')}>
          <Calendar size={15} className="shrink-0 text-muted-foreground" /><span className="truncate">{describeRange(value, placeholder, i18nStrings)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={4} className="z-50 w-80 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
          {rangeSelectorMode === 'default' && (
            <div className="mb-3"><SegmentedControl selectedId={mode} onChange={({ detail }: any) => setMode(detail.selectedId)}
              options={[{ id: 'relative', text: i18nStrings?.relativeModeTitle || 'Relative range' }, { id: 'absolute', text: i18nStrings?.absoluteModeTitle || 'Absolute range' }]} /></div>
          )}
          {mode === 'relative' ? (
            <div className="flex flex-col gap-1">
              {relativeOptions.map((o: any) => (
                <button key={o.key} type="button" onClick={() => setRel(o)} className={cn('rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary', rel?.key === o.key && 'bg-primary/10 font-medium text-primary')}>
                  {i18nStrings?.formatRelativeRange ? i18nStrings.formatRelativeRange(o) : `Last ${o.amount} ${o.unit}${o.amount === 1 ? '' : 's'}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">Start<input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className={cn(FIELD, 'mt-1')} /></label>
              <label className="text-xs font-medium text-muted-foreground">End<input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} className={cn(FIELD, 'mt-1')} /></label>
            </div>
          )}
          {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
          <div className="mt-3 flex justify-end gap-2">
            {value && <Button variant="link" onClick={() => { setOpen(false); fire(onChange, { value: null }); }}>{i18nStrings?.clearButtonLabel || 'Clear'}</Button>}
            <Button variant="primary" onClick={apply}>{i18nStrings?.applyButtonLabel || 'Apply'}</Button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
export const _rangeMs = UNIT_MS;

// ---------------------------------------------------------------------------
// TextFilter
// ---------------------------------------------------------------------------

export function TextFilter({ filteringText, filteringPlaceholder, onChange, onDelayedChange, countText, filteringAriaLabel, disabled }: any) {
  const timer = useRef<any>(null);
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-full max-w-md">
        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input value={filteringText ?? ''} placeholder={filteringPlaceholder || 'Search'} aria-label={filteringAriaLabel || filteringPlaceholder || 'Filter'} disabled={disabled}
          onChange={(e) => { const v = e.target.value; fire(onChange, { filteringText: v }); clearTimeout(timer.current); timer.current = setTimeout(() => fire(onDelayedChange, { filteringText: v }), 300); }}
          className={cn(FIELD, 'pl-8 pr-8')} />
        {filteringText && (
          <button type="button" aria-label="Clear filter" onClick={() => { fire(onChange, { filteringText: '' }); fire(onDelayedChange, { filteringText: '' }); }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"><X size={14} /></button>
        )}
      </div>
      {countText && filteringText && <span className="whitespace-nowrap text-xs text-muted-foreground">{countText}</span>}
    </div>
  );
}
