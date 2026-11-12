import React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  RefreshCw, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Plus, Minus, Share2, Play, Sparkles, Copy,
  Upload, Monitor, KeyRound, Info, Download, X, Pencil, Search, User, Lock, Loader2, AlertTriangle,
  CheckCircle2, XCircle, Clock, Menu, ExternalLink, Settings, Filter, Calendar, MoreVertical, Trash2,
  ArrowUpRight, Folder, FileText, type LucideIcon,
} from 'lucide-react';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Cloudscape handlers receive a CancelableEventHandler-shaped object:
 * `{ detail, preventDefault(), defaultPrevented }`. Pages destructure
 * `({ detail })` and some call `event.preventDefault()`, so every kit
 * component emits that shape.
 */
export interface KitEvent<T> { detail: T; preventDefault: () => void; defaultPrevented: boolean; nativeEvent?: any }
export function fire<T>(handler: ((e: KitEvent<T>) => void) | undefined, detail: T, nativeEvent?: any): KitEvent<T> {
  const ev: KitEvent<T> = {
    detail,
    defaultPrevented: false,
    preventDefault() { ev.defaultPrevented = true; nativeEvent?.preventDefault?.(); },
    nativeEvent,
  };
  handler?.(ev);
  return ev;
}

const ICONS: Record<string, LucideIcon> = {
  refresh: RefreshCw, 'angle-left': ChevronLeft, 'angle-right': ChevronRight, 'angle-down': ChevronDown,
  'angle-up': ChevronUp, 'add-plus': Plus, remove: Minus, share: Share2, 'caret-right-filled': Play,
  'caret-down-filled': ChevronDown, 'caret-up-filled': ChevronUp, 'gen-ai': Sparkles, copy: Copy,
  upload: Upload, multiscreen: Monitor, key: KeyRound, 'status-info': Info, download: Download, close: X,
  edit: Pencil, search: Search, 'user-profile': User, 'lock-private': Lock, 'status-in-progress': Loader2,
  'status-warning': AlertTriangle, 'status-positive': CheckCircle2, 'status-negative': XCircle,
  'status-pending': Clock, menu: Menu, external: ExternalLink, settings: Settings, filter: Filter,
  calendar: Calendar, 'ellipsis': MoreVertical, delete: Trash2, 'arrow-right': ArrowUpRight, folder: Folder,
  file: FileText,
};

export function KitIcon({ name, size = 16, className }: { name?: string; size?: number; className?: string }) {
  if (!name) return null;
  const C = ICONS[name] || Info;
  return <C size={size} strokeWidth={2} className={cn('shrink-0', name === 'status-in-progress' && 'animate-spin', className)} aria-hidden />;
}

/** Cloudscape spacing scale -> px. */
export const SPACE: Record<string, number> = { n: 0, xxxs: 2, xxs: 4, xs: 8, s: 12, m: 16, l: 20, xl: 24, xxl: 32 };

/** Plain text of a ReactNode, for aria labels and filtering. */
export function textOf(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf((node.props as any).children);
  return '';
}
