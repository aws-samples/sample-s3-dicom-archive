/**
 * website UI kit, exported under the same names and prop contracts the pages
 * were written against (Cloudscape). vite.config.ts aliases
 * '@cloudscape-design/components' to this module, so page code is unchanged
 * and every feature keeps working while the look is entirely this kit's.
 */
import type React from 'react';

export { Box, SpaceBetween, Header, Container, ContentLayout, ColumnLayout, Grid, Badge, StatusIndicator, Spinner, Icon, Link, Alert, Flashbar, ProgressBar, KeyValuePairs, ExpandableSection } from './base';
export { Button, ButtonDropdown, FormField, Form, Input, Textarea, Select, Multiselect, Autosuggest, Checkbox, Toggle, RadioGroup, Tiles, SegmentedControl, DatePicker, DateRangePicker, TextFilter } from './form';
export { Modal, Tabs } from './overlay';
export { Table, Pagination, CollectionPreferences, Cards } from './table';
export { LineChart, PieChart } from './charts';
export { AppLayout, SideNavigation, TopNavigation, AppShell } from './layout';

/* Type namespaces the pages import (e.g. SelectProps.Option). */
export namespace SelectProps {
  export interface Option { label?: string; value?: string; description?: string; disabled?: boolean; tags?: string[]; labelTag?: string; iconName?: string; filteringTags?: string[] }
  export interface OptionGroup extends Option { options: Option[] }
  export type Options = ReadonlyArray<Option | OptionGroup>;
}
export namespace MultiselectProps {
  export type Option = SelectProps.Option;
  export type Options = SelectProps.Options;
}
export namespace TableProps {
  export interface ColumnDefinition<T = any> {
    id?: string; header?: React.ReactNode; cell: (item: T) => React.ReactNode; width?: number | string; minWidth?: number | string;
    maxWidth?: number | string; sortingField?: string; sortingComparator?: (a: T, b: T) => number; isRowHeader?: boolean; ariaLabel?: any;
  }
  export interface SortingColumn<T = any> { sortingField?: string; sortingComparator?: (a: T, b: T) => number }
}
export namespace SideNavigationProps {
  export interface Link { type: 'link'; text: string; href: string; external?: boolean; info?: React.ReactNode }
  export interface Section { type: 'section'; text: string; items: ReadonlyArray<Item>; defaultExpanded?: boolean }
  export interface ExpandableLinkGroup { type: 'expandable-link-group'; text: string; href: string; items: ReadonlyArray<Item>; defaultExpanded?: boolean }
  export interface Divider { type: 'divider' }
  export type Item = Link | Section | ExpandableLinkGroup | Divider;
}
export namespace FlashbarProps {
  export interface MessageDefinition { type?: 'success' | 'error' | 'warning' | 'info' | 'in-progress'; header?: React.ReactNode; content?: React.ReactNode; dismissible?: boolean; onDismiss?: (e: any) => void; id?: string; loading?: boolean; action?: React.ReactNode; buttonText?: string; onButtonClick?: () => void; statusIconAriaLabel?: string; dismissLabel?: string }
}
export namespace TabsProps {
  export interface Tab { id: string; label: React.ReactNode; content?: React.ReactNode; disabled?: boolean; href?: string }
}
export namespace DateRangePickerProps {
  export interface RelativeValue { type: 'relative'; key?: string; amount: number; unit: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' }
  export interface AbsoluteValue { type: 'absolute'; startDate: string; endDate: string }
  export type Value = RelativeValue | AbsoluteValue;
  export type RelativeOption = RelativeValue & { key: string };
  export interface ValidRangeResult { valid: true }
  export interface InvalidRangeResult { valid: false; errorMessage: string }
  export type ValidationResult = ValidRangeResult | InvalidRangeResult;
}
export namespace ButtonDropdownProps {
  export interface Item { id: string; text: string; disabled?: boolean; description?: string; href?: string; external?: boolean; iconName?: string }
  export interface ItemGroup { id?: string; text?: string; items: ReadonlyArray<Item | ItemGroup> }
  export type Items = ReadonlyArray<Item | ItemGroup>;
}
export namespace RadioGroupProps { export interface RadioButtonDefinition { value: string; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean } }
export namespace TilesProps { export interface TilesDefinition { value: string; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean; image?: React.ReactNode } }
export namespace BoxProps { export type Variant = string }
export namespace BadgeProps { export type Color = string }
export namespace StatusIndicatorProps { export type Type = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'in-progress' | 'loading' | 'stopped' }
export namespace InputProps { export type Type = string }
export namespace CollectionPreferencesProps { export interface Preferences { pageSize?: number; wrapLines?: boolean; visibleContent?: ReadonlyArray<string>; stripedRows?: boolean } }
export namespace KeyValuePairsProps { export interface Pair { label?: React.ReactNode; value: React.ReactNode; info?: React.ReactNode } }
export namespace PieChartProps { export interface Datum { title: string; value: number; color?: string } }
export namespace TopNavigationProps { export type Utility = any }
export type NonCancelableCustomEvent<T> = { detail: T };
export type CancelableEventHandler<T = any> = (e: { detail: T; preventDefault: () => void }) => void;
