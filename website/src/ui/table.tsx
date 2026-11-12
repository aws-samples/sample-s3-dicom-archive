import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronRight as Caret, Loader2, Settings2 } from 'lucide-react';
import { cn, fire } from './util';
import { Checkbox, RadioGroup, Toggle, Button } from './form';
import { Modal } from './overlay';

type Col = {
  id?: string; header?: React.ReactNode; cell?: (item: any) => React.ReactNode; width?: number | string; minWidth?: number | string;
  maxWidth?: number | string; sortingField?: string; sortingComparator?: (a: any, b: any) => number; isRowHeader?: boolean; ariaLabel?: any;
};

export interface TableProps {
  items?: any[]; columnDefinitions?: Col[]; empty?: React.ReactNode; loading?: boolean; loadingText?: string; header?: React.ReactNode;
  footer?: React.ReactNode; selectionType?: 'single' | 'multi'; selectedItems?: any[]; onSelectionChange?: (e: any) => void;
  pagination?: React.ReactNode; filter?: React.ReactNode; variant?: string; trackBy?: string | ((item: any) => string);
  preferences?: React.ReactNode; ariaLabels?: any; sortingDisabled?: boolean; stickyHeader?: boolean; sortingColumn?: Col;
  sortingDescending?: boolean; onSortingChange?: (e: any) => void; wrapLines?: boolean; expandableRows?: any;
  isItemDisabled?: (item: any) => boolean; columnDisplay?: Array<{ id: string; visible: boolean }>; visibleColumns?: string[];
  stripedRows?: boolean; contentDensity?: 'comfortable' | 'compact'; onRowClick?: (e: any) => void; renderAriaLive?: any;
  resizableColumns?: boolean; totalItemsCount?: number; firstIndex?: number;
}

const px = (v?: number | string) => (v == null ? undefined : typeof v === 'number' ? `${v}px` : v);

export function Table(props: TableProps) {
  const {
    items = [], columnDefinitions = [], empty, loading, loadingText, header, footer, selectionType, selectedItems = [], onSelectionChange,
    pagination, filter, variant, trackBy, preferences, ariaLabels, sortingDisabled, stickyHeader, sortingColumn, sortingDescending,
    onSortingChange, wrapLines, expandableRows, isItemDisabled, columnDisplay, visibleColumns, stripedRows, contentDensity, onRowClick,
  } = props;

  const keyOf = (it: any, i: number) => (typeof trackBy === 'function' ? trackBy(it) : trackBy ? it?.[trackBy] : undefined) ?? i;
  const same = (a: any, b: any) => (trackBy ? keyOf(a, -1) === keyOf(b, -2) : a === b);
  const isSel = (it: any) => selectedItems.some(s => same(s, it));

  // Columns: columnDisplay (order + visibility) > visibleColumns > all.
  const cols = useMemo(() => {
    if (columnDisplay && columnDisplay.length) {
      const byId = new Map(columnDefinitions.map(c => [c.id, c]));
      return columnDisplay.filter(d => d.visible).map(d => byId.get(d.id)).filter(Boolean) as Col[];
    }
    if (visibleColumns) return columnDefinitions.filter(c => !c.id || visibleColumns.includes(c.id));
    return columnDefinitions;
  }, [columnDefinitions, columnDisplay, visibleColumns]);

  // Sorting: controlled when the page handles onSortingChange, otherwise local.
  const [localSort, setLocalSort] = useState<{ col?: Col; desc: boolean }>({ desc: false });
  const controlled = !!onSortingChange;
  const sortCol = controlled ? sortingColumn : localSort.col;
  const sortDesc = controlled ? !!sortingDescending : localSort.desc;
  const sameCol = (a?: Col, b?: Col) => !!a && !!b && ((a.sortingField && a.sortingField === b.sortingField) || (a.id && a.id === b.id) || a === b);
  const rows = useMemo(() => {
    if (controlled || !sortCol) return items;
    const c = sortCol;
    const cmp = c.sortingComparator || ((a: any, b: any) => {
      const x = a?.[c.sortingField as string]; const y = b?.[c.sortingField as string];
      if (x == null) return 1; if (y == null) return -1;
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    });
    const out = [...items].sort(cmp);
    return sortDesc ? out.reverse() : out;
  }, [items, controlled, sortCol, sortDesc]);
  const clickSort = (c: Col) => {
    const desc = sameCol(sortCol, c) ? !sortDesc : false;
    if (controlled) fire(onSortingChange, { sortingColumn: c, isDescending: desc });
    else setLocalSort({ col: c, desc });
  };

  // Tree rows
  const [innerExpanded, setInnerExpanded] = useState<any[]>([]);
  const expanded: any[] = expandableRows?.expandedItems ?? innerExpanded;
  const isExpanded = (it: any) => expanded.some(e => same(e, it));
  const toggleExpand = (it: any) => {
    const next = !isExpanded(it);
    if (expandableRows?.onExpandableItemToggle) fire(expandableRows.onExpandableItemToggle, { item: it, expanded: next });
    if (!expandableRows?.expandedItems) setInnerExpanded(e => (next ? [...e, it] : e.filter(x => !same(x, it))));
  };
  const visible: Array<{ item: any; level: number }> = [];
  const walk = (list: any[], level: number) => {
    for (const it of list) {
      visible.push({ item: it, level });
      if (expandableRows && isExpanded(it)) walk(expandableRows.getItemChildren?.(it) || [], level + 1);
    }
  };
  walk(rows, 0);

  const selectable = rows.filter(it => !isItemDisabled?.(it));
  const allSel = selectionType === 'multi' && selectable.length > 0 && selectable.every(isSel);
  const someSel = selectionType === 'multi' && !allSel && selectable.some(isSel);
  const setSel = (next: any[]) => fire(onSelectionChange, { selectedItems: next });
  const toggleRow = (it: any) => {
    if (isItemDisabled?.(it)) return;
    if (selectionType === 'single') setSel([it]);
    else if (selectionType === 'multi') setSel(isSel(it) ? selectedItems.filter(s => !same(s, it)) : [...selectedItems, it]);
  };

  const compact = contentDensity === 'compact';
  const embedded = variant === 'embedded' || variant === 'borderless';
  const cellPad = compact ? 'px-3 py-1.5' : 'px-3 py-2.5';
  const colCount = cols.length + (selectionType ? 1 : 0);
  // Only the first load (nothing on screen yet) replaces the rows with the
  // loading placeholder. A refresh while rows are showing keeps them and shows
  // a thin progress bar, so actions never blank the table.
  const blocking = !!loading && visible.length === 0;
  const refreshing = !!loading && !blocking;

  const tools = (filter || pagination || preferences) && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">{filter}</div>
      <div className="flex items-center gap-2">{pagination}{preferences}</div>
    </div>
  );

  return (
    <div className={cn(!embedded && 'rounded-xl border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]')}>
      {(header || tools) && (
        <div className={cn('flex flex-col gap-3', embedded ? 'pb-3' : 'px-5 pt-4 pb-3')}>
          {header}
          {tools}
        </div>
      )}
      <div tabIndex={0} aria-label="Table" className={cn('ui-scroll overflow-x-auto focus-visible:outline-offset-[-2px]', stickyHeader && 'max-h-[70vh] overflow-y-auto')}>
        <table className={cn('w-full border-collapse text-sm', refreshing && 'transition-opacity [&>tbody]:opacity-70')} aria-busy={loading || undefined}>
          <thead className={cn(stickyHeader && 'sticky top-0 z-[1]')}>
            <tr className="border-y bg-muted/60 text-left">
              {selectionType && (
                <th className={cn('w-10', cellPad)}>
                  {selectionType === 'multi' && (
                    <Checkbox checked={allSel} indeterminate={someSel} disabled={!selectable.length}
                      ariaLabel={ariaLabels?.allItemsSelectionLabel?.({ selectedItems }) || 'Select all'}
                      onChange={() => setSel(allSel ? [] : [...selectedItems.filter(s => !rows.some(r => same(r, s))), ...selectable])} />
                  )}
                </th>
              )}
              {cols.map((c, i) => {
                const sortable = !sortingDisabled && (c.sortingField || c.sortingComparator);
                const on = sameCol(sortCol, c);
                return (
                  <th key={c.id || i} scope="col" style={{ width: px(c.width), minWidth: px(c.minWidth), maxWidth: px(c.maxWidth) }}
                    aria-sort={on ? (sortDesc ? 'descending' : 'ascending') : undefined}
                    className={cn('whitespace-nowrap text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground', cellPad)}>
                    {sortable ? (
                      <button type="button" onClick={() => clickSort(c)} className="group inline-flex items-center gap-1 uppercase hover:text-foreground">
                        {c.header}
                        {on ? (sortDesc ? <ArrowDown size={13} /> : <ArrowUp size={13} />) : <ArrowUpDown size={13} className="opacity-0 group-hover:opacity-60" />}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
            {refreshing && (
              <tr aria-hidden="true">
                <th colSpan={colCount} className="p-0">
                  <div className="ui-refresh-bar" />
                </th>
              </tr>
            )}
          </thead>
          <tbody>
            {blocking && (
              <tr><td colSpan={colCount} className="px-4 py-10 text-center text-muted-foreground"><Loader2 size={18} className="mr-2 inline animate-spin align-[-4px]" />{loadingText || 'Loading'}</td></tr>
            )}
            {!loading && visible.length === 0 && (
              <tr><td colSpan={colCount} className="px-4 py-10 text-center text-muted-foreground">{empty || 'No items'}</td></tr>
            )}
            {!blocking && visible.map(({ item, level }, r) => {
              const sel = isSel(item);
              const disabled = isItemDisabled?.(item);
              const kids = expandableRows && (expandableRows.isItemExpandable ? expandableRows.isItemExpandable(item) : (expandableRows.getItemChildren?.(item) || []).length > 0);
              return (
                <tr key={`${level}-${String(keyOf(item, r))}-${r}`}
                  onClick={(e) => { if (onRowClick) fire(onRowClick, { item, rowIndex: r }, e); }}
                  className={cn('border-b last:border-b-0 transition-colors hover:bg-muted/50', sel && 'bg-primary/6 hover:bg-primary/9', stripedRows && r % 2 === 1 && !sel && 'bg-muted/25', disabled && 'opacity-60')}>
                  {selectionType && (
                    <td className={cn('w-10 align-middle', cellPad)} onClick={(e) => e.stopPropagation()}>
                      {selectionType === 'multi'
                        ? <Checkbox checked={sel} disabled={disabled} ariaLabel={ariaLabels?.itemSelectionLabel?.({ selectedItems }, item) || 'Select row'} onChange={() => toggleRow(item)} />
                        : <input type="radio" checked={sel} disabled={disabled} aria-label={ariaLabels?.itemSelectionLabel?.({ selectedItems }, item) || 'Select row'} onChange={() => toggleRow(item)} className="size-4 accent-[var(--color-primary)]" />}
                    </td>
                  )}
                  {cols.map((c, i) => {
                    const Tag: any = c.isRowHeader ? 'th' : 'td';
                    return (
                      <Tag key={c.id || i} scope={c.isRowHeader ? 'row' : undefined}
                        style={{ width: px(c.width), minWidth: px(c.minWidth), maxWidth: px(c.maxWidth) }}
                        className={cn('text-left align-middle font-normal', cellPad, wrapLines ? 'whitespace-normal break-words' : 'whitespace-nowrap overflow-hidden text-ellipsis')}>
                        {i === 0 && expandableRows ? (
                          <span className="inline-flex items-center gap-1" style={{ paddingLeft: level * 20 }}>
                            {kids ? (
                              <button type="button" aria-label={isExpanded(item) ? 'Collapse' : 'Expand'} onClick={(e) => { e.stopPropagation(); toggleExpand(item); }}
                                className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                                <Caret size={14} className={cn('transition-transform', isExpanded(item) && 'rotate-90')} />
                              </button>
                            ) : <span className="inline-block w-[18px]" />}
                            {c.cell?.(item)}
                          </span>
                        ) : c.cell?.(item)}
                      </Tag>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && <div className="border-t px-5 py-3 text-center">{footer}</div>}
    </div>
  );
}

export function Pagination({ currentPageIndex = 1, pagesCount = 1, onChange, openEnd, ariaLabels, disabled, onNextPageClick, onPreviousPageClick }: any) {
  const go = (i: number) => { if (i < 1 || (!openEnd && i > pagesCount)) return; fire(onChange, { currentPageIndex: i }); };
  const pages: Array<number | '…'> = [];
  const last = Math.max(1, pagesCount);
  const add = (n: number) => { if (!pages.includes(n)) pages.push(n); };
  add(1);
  if (currentPageIndex > 3) pages.push('…');
  for (let i = Math.max(2, currentPageIndex - 1); i <= Math.min(last - 1, currentPageIndex + 1); i++) add(i);
  if (currentPageIndex < last - 2) pages.push('…');
  if (last > 1) add(last);
  const btn = 'inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-sm tabular-nums';
  return (
    <nav aria-label={ariaLabels?.paginationLabel || 'Pagination'} className="flex items-center gap-0.5">
      <button type="button" aria-label={ariaLabels?.previousPageLabel || 'Previous page'} disabled={disabled || currentPageIndex <= 1}
        onClick={() => { fire(onPreviousPageClick, { requestedPageIndex: currentPageIndex - 1 }); go(currentPageIndex - 1); }} className={cn(btn, 'text-muted-foreground hover:bg-secondary disabled:opacity-40')}><ChevronLeft size={15} /></button>
      {pages.map((p, i) => p === '…'
        ? <span key={`e${i}`} className="px-1 text-muted-foreground">…</span>
        : <button key={p} type="button" aria-current={p === currentPageIndex ? 'page' : undefined} aria-label={ariaLabels?.pageLabel?.(p) || `Page ${p}`} disabled={disabled}
            onClick={() => go(p)} className={cn(btn, p === currentPageIndex ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-secondary')}>{p}</button>)}
      {openEnd && <span className="px-1 text-muted-foreground">…</span>}
      <button type="button" aria-label={ariaLabels?.nextPageLabel || 'Next page'} disabled={disabled || (!openEnd && currentPageIndex >= last)}
        onClick={() => { fire(onNextPageClick, { requestedPageIndex: currentPageIndex + 1 }); go(currentPageIndex + 1); }} className={cn(btn, 'text-muted-foreground hover:bg-secondary disabled:opacity-40')}><ChevronRight size={15} /></button>
    </nav>
  );
}

export function CollectionPreferences({ title = 'Preferences', confirmLabel = 'Confirm', cancelLabel = 'Cancel', preferences = {}, onConfirm,
  pageSizePreference, wrapLinesPreference, visibleContentPreference, stripedRowsPreference, contentDisplayPreference }: any) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<any>(preferences);
  const openIt = () => { setDraft(preferences); setOpen(true); };
  const visible: string[] = draft.visibleContent || [];
  return (
    <>
      <button type="button" aria-label={title} onClick={openIt} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground">
        <Settings2 size={16} />
      </button>
      <Modal visible={open} onDismiss={() => setOpen(false)} header={title} size="medium"
        footer={<div className="flex justify-end gap-2"><Button variant="link" onClick={() => setOpen(false)}>{cancelLabel}</Button>
          <Button variant="primary" onClick={() => { setOpen(false); fire(onConfirm, draft); }}>{confirmLabel}</Button></div>}>
        <div className="grid gap-6 sm:grid-cols-2">
          <div className="flex flex-col gap-5">
            {pageSizePreference && (
              <div>
                <div className="mb-2 text-sm font-semibold">{pageSizePreference.title || 'Page size'}</div>
                <RadioGroup value={draft.pageSize} items={(pageSizePreference.options || []).map((o: any) => ({ value: o.value, label: o.label ?? `${o.value} items` }))}
                  onChange={({ detail }: any) => setDraft({ ...draft, pageSize: detail.value })} />
              </div>
            )}
            {wrapLinesPreference && (
              <Toggle checked={!!draft.wrapLines} onChange={({ detail }: any) => setDraft({ ...draft, wrapLines: detail.checked })} description={wrapLinesPreference.description}>
                {wrapLinesPreference.label || 'Wrap lines'}
              </Toggle>
            )}
            {stripedRowsPreference && (
              <Toggle checked={!!draft.stripedRows} onChange={({ detail }: any) => setDraft({ ...draft, stripedRows: detail.checked })}>{stripedRowsPreference.label || 'Striped rows'}</Toggle>
            )}
          </div>
          {visibleContentPreference && (
            <div>
              <div className="mb-2 text-sm font-semibold">{visibleContentPreference.title || 'Visible columns'}</div>
              {(visibleContentPreference.options || []).map((g: any, gi: number) => (
                <div key={gi} className="mb-3">
                  {g.label && <div className="mb-1.5 text-xs font-medium text-muted-foreground">{g.label}</div>}
                  <div className="flex flex-col gap-2">
                    {(g.options || []).map((o: any) => (
                      <Toggle key={o.id} checked={visible.includes(o.id)} disabled={o.editable === false}
                        onChange={({ detail }: any) => setDraft({ ...draft, visibleContent: detail.checked ? [...visible, o.id] : visible.filter(v => v !== o.id) })}>
                        {o.label}
                      </Toggle>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

export function Cards({ items = [], cardDefinition = {}, cardsPerRow, loading, loadingText, empty, header, selectionType, selectedItems = [], onSelectionChange, trackBy }: any) {
  const keyOf = (it: any, i: number) => (typeof trackBy === 'function' ? trackBy(it) : trackBy ? it?.[trackBy] : i);
  return (
    <div className="flex flex-col gap-3">
      {header}
      {loading && items.length > 0 && <div className="ui-refresh-bar" aria-hidden="true" />}
      {loading && !items.length ? <div className="py-10 text-center text-muted-foreground"><Loader2 className="mr-2 inline animate-spin" size={16} />{loadingText}</div>
        : !items.length ? <div className="py-10 text-center text-muted-foreground">{empty}</div> : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((it: any, i: number) => {
              const sel = selectedItems.includes(it);
              return (
                <div key={keyOf(it, i)} className={cn('rounded-xl border bg-card p-4', sel && 'border-primary ring-2 ring-primary/15')}
                  onClick={() => selectionType && fire(onSelectionChange, { selectedItems: selectionType === 'single' ? [it] : sel ? selectedItems.filter((s: any) => s !== it) : [...selectedItems, it] })}>
                  <div className="mb-2 font-semibold">{cardDefinition.header?.(it)}</div>
                  {(cardDefinition.sections || []).map((s: any, si: number) => (
                    <div key={s.id || si} className="mt-2">
                      {s.header && <div className="text-xs font-medium text-muted-foreground">{s.header}</div>}
                      <div className="text-sm">{s.content?.(it)}</div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
