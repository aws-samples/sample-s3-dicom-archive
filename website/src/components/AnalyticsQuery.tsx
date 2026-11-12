/**
 * PHI notice: this component queries and displays DICOM index data that can
 * contain Protected Health Information. Deployers are responsible for HIPAA
 * (and, where applicable, GDPR) controls under the AWS shared responsibility
 * model; use only synthetic data for testing. See PHI-HANDLING.md.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Table, Button, Header, SpaceBetween, Box, Select, Multiselect, Textarea,
  Alert, Spinner, StatusIndicator, Pagination, CollectionPreferences,
  Modal, FormField, RadioGroup, Input, Icon, ExpandableSection
} from '@cloudscape-design/components';
import ReactMarkdown from 'react-markdown';
import { apiClient } from '../services/apiClient';
import { usePrivileges } from '../hooks/usePrivileges';
import { useAuth } from '../contexts/AuthContext';
import ProcessingJobModal, { ProcessingJobTarget } from './ProcessingJobModal';
import '../styles/sql-editor.css';

const TEXT_TO_SQL = (window as any).REACT_APP_CONFIG?.TEXT_TO_SQL === 'true';
const VIRTUAL_FOLDER_ENABLED = (window as any).REACT_APP_CONFIG?.VIRTUAL_FOLDER === 'true';

// NO-PROJECTS model: AnalyticsQuery stands alone. The user picks an INDEX
// (a storage index = datastore, or a VF index = virtual folder) they have read
// access to — mirroring the DICOM Studies selector — and queries run directly
// against that index via the direct-SQL path (server scopes by source {kind,ids}).
type IndexKind = 'storage-index' | 'vf-index';
interface AnalyticsIndex {
  id: string;
  name: string;
  indexKind: IndexKind;
}
// Query scope sent to the backend. kind: 'storage' => datastore ids;
// 'vf' => virtual-folder ids. ids holds EVERY selected index id (all of one
// kind — the UI forbids mixing storage + VF in a single selection because a
// scope is one kind). The backend authorizes each id against the caller and
// builds a parameterized `datastore_id IN (...)` / `virtual_folder_id IN (...)`
// predicate, so a multi-id scope queries across storages / folders.
interface QueryScope { kind: 'storage' | 'vf'; ids: string[]; }
function scopeOfMany(idxs: AnalyticsIndex[]): QueryScope {
  const kind = idxs[0]?.indexKind === 'vf-index' ? 'vf' : 'storage';
  return { kind, ids: idxs.map(i => i.id) };
}

// Live index tables the direct-SQL path queries (no Glue table). Shown in the
// schema panel as a hint; the model gets the full schema server-side.
const SCHEMA_HINTS: { table: string; cols: string }[] = [
  { table: 'patient', cols: 'patientid, patientname, patientbirthdate, patientsex' },
  { table: 'study', cols: 'studyinstanceuid, studydate, accessionnumber, studydescription' },
  { table: 'series', cols: 'modality, seriesdescription, seriesinstanceuid, imagecount' },
  { table: 'instance', cols: 'content_pkey, sopclassuid, sopinstanceuid' },
  { table: 'Instancemetadata', cols: 'content_pkey, metadata (gzipped JSON), metadataendoffset' },
  { table: 'storage_index', cols: 'content_pkey, s3_key, content_kind, size_bytes' },
];

// ── SQL Code Editor (theme-aware) ──────────────────────────────────────────

function SqlEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursorPos, setCursorPos] = useState({ ln: 1, col: 1 });

  const updateCursor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const textBefore = value.substring(0, pos);
    const ln = (textBefore.match(/\n/g) || []).length + 1;
    const col = pos - textBefore.lastIndexOf('\n');
    setCursorPos({ ln, col });
  }, [value]);

  const syncScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const lineCount = Math.max((value.match(/\n/g) || []).length + 1, 10);
  const lineNumbers = Array.from({ length: Math.min(lineCount, 10) }, (_, i) => i + 1);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = textareaRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const newVal = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newVal);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
    }
  };

  return (
    <div className="sql-editor">
      <div className="sql-editor-body">
        <div ref={gutterRef} className="sql-editor-gutter">
          {lineNumbers.map(n => <div key={n}>{n}</div>)}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onKeyDown={handleKeyDown}
          onScroll={syncScroll}
          spellCheck={false}
          className="sql-editor-textarea"
          aria-label="SQL query"
        />
      </div>
      <div className="sql-editor-status">
        <span>SQL</span>
        <span>Ln {cursorPos.ln}, Col {cursorPos.col}</span>
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

const MAX_RESULTS_CHARS = 100_000;
function truncateRows(rows: any[]): any[] {
  let size = 0;
  for (let i = 0; i < rows.length; i++) {
    size += JSON.stringify(rows[i]).length;
    if (size > MAX_RESULTS_CHARS) return rows.slice(0, i);
  }
  return rows;
}

export default function AnalyticsQuery() {
  // Privilege-filtered, kind-tagged merged index list (storage + VF), mirroring
  // DicomStudiesManagement. Only indexes the user can READ are listed.
  const [indexes, setIndexes] = useState<AnalyticsIndex[]>([]);
  const [indexesLoading, setIndexesLoading] = useState(false);
  // Multi-select: the user may pick several indexes OF THE SAME KIND to query
  // across them. `primaryIndex` (the first selected) is used where a single
  // source id is needed as a stable key: the API route id (scopeId for
  // conversations) and the SQL/chat localStorage keys. The ENFORCED query scope
  // is scopeOfMany(selectedIndexes), which carries every id.
  const [selectedIndexes, setSelectedIndexes] = useState<AnalyticsIndex[]>([]);
  const selectedIndex = selectedIndexes[0] || null; // primary (single-source flows + keys)
  const [nlText, setNlText] = useState('');
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  // Resizable AI Assistant rail width (px), persisted; drag the left edge handle.
  const [railWidth, setRailWidth] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem('analytics-rail-width') || '', 10);
    return Number.isFinite(saved) && saved >= 300 && saved <= 720 ? saved : 380;
  });
  const railResizing = useRef(false);
  const startRailResize = (e: React.MouseEvent) => {
    e.preventDefault();
    railResizing.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!railResizing.current) return;
      // Dragging the left edge: width grows as the cursor moves left.
      const w = Math.min(720, Math.max(300, window.innerWidth - ev.clientX - 24));
      setRailWidth(w);
    };
    const onUp = () => {
      railResizing.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('analytics-rail-width', String(railWidthRef.current)); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const railWidthRef = useRef(railWidth);
  useEffect(() => { railWidthRef.current = railWidth; }, [railWidth]);

  // Persisted, per-user conversations (server-side history). When a conversation
  // is selected, the AI chat routes through the conversations API so history is
  // stored in analytics_conversations. When none is selected, the legacy
  // localStorage + one-shot /query path is used (back-compat).
  const [conversations, setConversations] = useState<any[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(false);

  // Conversation + chat localStorage keys now key on the INDEX id.
  const chatStorageKey = (indexId: string) => `analytics-chat-${cacheUser}-${indexId}`;
  const sqlStorageKey = (indexId: string) => `analytics-sql-${cacheUser}-${indexId}`;

  const loadChat = (indexId: string) => {
    try {
      const saved = localStorage.getItem(chatStorageKey(indexId));
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  };

  const saveChat = (indexId: string, messages: { role: 'user' | 'assistant'; text: string }[]) => {
    try { localStorage.setItem(chatStorageKey(indexId), JSON.stringify(messages)); } catch {}
  };
  const [sql, setSql] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [executionTimeMs, setExecutionTimeMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [queryStatus, setQueryStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [resultPageSize, setResultPageSize] = useState(50);
  const [resultPageIndex, setResultPageIndex] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [lastQueryType, setLastQueryType] = useState<'sql' | 'natural'>('sql');
  const [lastNlText, setLastNlText] = useState('');

  // Virtual folder assignment state
  const { privileges, hasDatastoreAccess, hasVirtualFolderAccess, hasManagementAccess } = usePrivileges();
  const { user } = useAuth();
  // Cache/session key component: the current user, so one browser profile never
  // serves another user's cached chat/SQL for the same database.
  const cacheUser = (user?.username || 'anon').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const [showVfModal, setShowVfModal] = useState(false);
  const [vfList, setVfList] = useState<any[]>([]);
  const [selectedVf, setSelectedVf] = useState<any>(null);
  const [vfMaxMode, setVfMaxMode] = useState<'all' | 'max'>('all');
  const [vfMaxCount, setVfMaxCount] = useState('100');
  const [vfSubmitting, setVfSubmitting] = useState(false);
  const [vfError, setVfError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Processing job state
  const canRunJobs = hasManagementAccess('processingJobs', 'canRun');
  const [showJobModal, setShowJobModal] = useState(false);
  const [jobTarget, setJobTarget] = useState<ProcessingJobTarget | null>(null);

  // A sensible default query for a freshly-selected index: DICOM studies joined
  // down to a scopeable content_pkey (the server scopes by content_pkey). It
  // deliberately selects no patient identifiers (name, ID, accession); results
  // can still contain PHI, see PHI-HANDLING.md.
  const defaultSql = () =>
    'SELECT st.studydate, st.studydescription, i.content_pkey\n' +
    'FROM study st\n' +
    'JOIN series se ON se.study_pkey = st.study_pkey\n' +
    'JOIN instance i ON i.series_pkey = se.series_pkey\n' +
    'LIMIT 10';

  // Load the privilege-filtered merged index list (storage + VF), mirroring the
  // DICOM Studies selector: getDatastores + hasDatastoreAccess(id|'*','canRead'),
  // getVirtualFolders + hasVirtualFolderAccess(id|'*','canRead').
  useEffect(() => {
    // Wait until privileges are loaded — the filters below read them, so running
    // before they arrive would drop every index and leave the dropdown empty.
    if (!privileges) return;
    let cancelled = false;
    (async () => {
      setIndexesLoading(true);
      const merged: AnalyticsIndex[] = [];
      const errors: string[] = [];
      try {
        const dsResp = await apiClient.getDatastores({ pageSize: 100 });
        const items = dsResp.data?.items || [];
        items
          .filter((d: any) => (d.status?.toUpperCase?.() ?? 'ACTIVE') === 'ACTIVE')
          .filter((d: any) => hasDatastoreAccess(d.id, 'canRead') || hasDatastoreAccess('*', 'canRead'))
          .forEach((d: any) => merged.push({ id: d.id, name: d.name, indexKind: 'storage-index' }));
      } catch (e: any) { errors.push(`storages: ${e?.message || e}`); }
      if (VIRTUAL_FOLDER_ENABLED) {
        try {
          const vfResp = await apiClient.getVirtualFolders({ pageSize: 100 });
          const items = vfResp.data?.items || [];
          items
            .filter((f: any) => (f.status?.toUpperCase?.() ?? 'ACTIVE') === 'ACTIVE')
            .filter((f: any) => hasVirtualFolderAccess(f.id, 'canRead') || hasVirtualFolderAccess('*', 'canRead'))
            .forEach((f: any) => merged.push({ id: f.id, name: f.name, indexKind: 'vf-index' }));
        } catch (e: any) { errors.push(`virtual folders: ${e?.message || e}`); }
      }
      if (cancelled) return;
      setIndexes(merged);
      if (errors.length && !merged.length) setError(`Could not load ${errors.join('; ')}`);
      setIndexesLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privileges]);

  // Multi-select handler. The Multiselect passes the full set of chosen options;
  // we resolve them back to AnalyticsIndex and ENFORCE a single kind (a scope is
  // storage OR vf, never mixed). If the user's new pick introduces a second
  // kind, we keep only the ids matching the kind of the FIRST selected item.
  const onSelectIndexes = async (picked: AnalyticsIndex[]) => {
    let next = picked;
    if (picked.length) {
      const kind = picked[0].indexKind;
      const filtered = picked.filter(i => i.indexKind === kind);
      if (filtered.length !== picked.length) {
        setError('A query can span multiple storages OR multiple virtual folders, but not a mix of both. Kept only the matching kind.');
      }
      next = filtered;
    }
    const prevPrimaryId = selectedIndexes[0]?.id;
    setSelectedIndexes(next);
    const primary = next[0] || null;
    setRows([]); setColumns([]); setExecutionTimeMs(null); setQueryStatus('idle');
    if (!primary) { setSql(defaultSql()); setChatMessages([]); setActiveConversationId(null); return; }
    // Keys (SQL/chat/conversations) follow the PRIMARY index. Only reset those
    // when the primary changed, so adding/removing a secondary storage keeps the
    // current editor + chat.
    if (primary.id !== prevPrimaryId) {
      setError('');
      setSql(localStorage.getItem(sqlStorageKey(primary.id)) || defaultSql());
      setChatMessages(loadChat(primary.id));
      setActiveConversationId(null);
      fetchConversations(primary.id);
    }
  };

  // ── Persisted conversations ───────────────────────────────────────────────
  // Conversations key on the INDEX id (analytics_conversations.project_id now
  // holds the index id server-side).

  const fetchConversations = async (indexId: string) => {
    setConversationsLoading(true);
    try {
      const resp = await apiClient.listAnalyticsConversations(indexId);
      setConversations(resp.data || []);
    } catch { setConversations([]); }
    setConversationsLoading(false);
  };

  // Load a persisted conversation's messages into the chat pane.
  const selectConversation = async (conversationId: string) => {
    if (!selectedIndex) return;
    setActiveConversationId(conversationId);
    setError('');
    try {
      const resp = await apiClient.getAnalyticsConversation(selectedIndex.id, conversationId);
      const msgs = (resp.data?.messages || []).map((m: any) => ({ role: m.role, text: m.text }));
      setChatMessages(msgs);
      if (resp.data?.lastSql) setSql(resp.data.lastSql);
    } catch (e: any) { setError(e.message || 'Failed to load conversation'); }
  };

  // Start a fresh persisted conversation (clears the chat pane).
  const startNewConversation = async () => {
    if (!selectedIndex) return;
    try {
      const resp = await apiClient.createAnalyticsConversation(selectedIndex.id);
      const conv = resp.data;
      if (conv?.id) {
        setActiveConversationId(conv.id);
        setChatMessages([]);
        await fetchConversations(selectedIndex.id);
      }
    } catch (e: any) { setError(e.message || 'Failed to create conversation'); }
  };

  const deleteConversation = async (conversationId: string) => {
    if (!selectedIndex) return;
    try {
      await apiClient.deleteAnalyticsConversation(selectedIndex.id, conversationId);
      if (activeConversationId === conversationId) {
        setActiveConversationId(null);
        setChatMessages([]);
      }
      await fetchConversations(selectedIndex.id);
    } catch (e: any) { setError(e.message || 'Failed to delete conversation'); }
  };

  // Reset the chat: clears the on-screen pane AND the persisted context session.
  // When a DB-backed conversation is active, DELETE it server-side (drops the
  // stored history in analytics_conversations); otherwise clear the local
  // legacy-mode cache. Always clears the input.
  const resetChat = async () => {
    if (!selectedIndex) return;
    setNlText('');
    setChatMessages([]);
    const conv = activeConversationId;
    setActiveConversationId(null);
    localStorage.removeItem(chatStorageKey(selectedIndex.id));
    if (conv) {
      try {
        await apiClient.deleteAnalyticsConversation(selectedIndex.id, conv);
        await fetchConversations(selectedIndex.id);
      } catch (e: any) { setError(e.message || 'Failed to reset conversation'); }
    }
  };

  // Poll Athena query status until terminal state
  const pollAthenaQuery = useCallback(async (projectId: string, queryExecutionId: string, pgSize: number): Promise<any> => {
    for (let i = 0; i < 300; i++) { // up to 5 min
      await new Promise(r => setTimeout(r, 2000));
      const resp = await apiClient.makeRequest<any>(`/analytics-projects/${projectId}/query/${queryExecutionId}?pageSize=${pgSize}`);
      const status = resp.data?.status;
      if (status === 'SUCCEEDED') return resp;
      if (status === 'FAILED' || status === 'CANCELLED') throw new Error(resp.data?.error || 'Query failed');
    }
    throw new Error('Query timed out');
  }, []);

  // Send a chat message through the PERSISTED conversation flow: the server
  // loads history from analytics_conversations, calls text-to-sql, persists the
  // turn, and returns the generated SQL. We then EXECUTE that SQL via the normal
  // /query type:'sql' path (execution stays a separate, explicit step — the
  // message route already persisted the turn, so we do not double-persist).
  const sendConversationMessage = async () => {
    if (!selectedIndex || !activeConversationId || !nlText.trim()) return;
    const scope = scopeOfMany(selectedIndexes);
    const userMsg = nlText.trim();
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
    setNlText(''); setLastNlText(userMsg); setResultPageIndex(1);
    setGenerating(true); setError('');
    try {
      const resp = await apiClient.sendAnalyticsConversationMessage(
        selectedIndex.id, activeConversationId,
        { text: userMsg, pageSize: resultPageSize, pageOffset: 0, source: scope }
      );
      const gen = resp.data?.generated;
      const assistantText = resp.data?.assistantMessage?.text || gen?.explanation || gen?.answer || '';
      if (assistantText) setChatMessages(prev => [...prev, { role: 'assistant', text: assistantText }]);
      // Refresh list so the derived title / ordering updates.
      fetchConversations(selectedIndex.id);

      if (gen && gen.mode !== 'chat' && gen.sql) {
        setSql(gen.sql);
        // Execute the generated SQL (direct MySQL — returns rows synchronously).
        const runResp = await apiClient.makeRequest<any>(`/analytics-projects/${selectedIndex.id}/query`, {
          method: 'POST', body: JSON.stringify({ type: 'sql', sql: gen.sql, pageSize: resultPageSize, pageOffset: 0, source: scope })
        });
        let data = runResp.data || {};
        if (data.queryExecutionId && data.status === 'RUNNING') {
          const pollResp = await pollAthenaQuery(selectedIndex.id, data.queryExecutionId, resultPageSize);
          data = pollResp.data || {};
        }
        setRows(data.rows || []);
        setColumns(data.rows?.length ? Object.keys(data.rows[0]) : []);
        setExecutionTimeMs(data.executionTimeMs);
        setHasNextPage(data.hasNextPage || false);
        setQueryStatus('success');
        // Conversation-generated SQL is now the editor content; page it as SQL.
        setLastQueryType('sql');
      }
    } catch (e: any) {
      setChatMessages(prev => prev.slice(0, -1)); // drop the user bubble on error
      setError(e.message || 'Failed to send message'); setQueryStatus('error');
    }
    setGenerating(false);
  };

  const generateSql = async (pageOverride?: number) => {
    // Persisted-conversation flow only applies to fresh sends, not result paging.
    if (activeConversationId && pageOverride === undefined) {
      await sendConversationMessage();
      return;
    }
    if (!selectedIndex || (!nlText.trim() && pageOverride === undefined)) return;
    const scope = scopeOfMany(selectedIndexes);
    const userMsg = nlText.trim();
    const currentPage = pageOverride ?? 0;
    if (pageOverride === undefined) {
      setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);
      setNlText('');
      setLastNlText(userMsg);
      setResultPageIndex(1);
    }
    setGenerating(true); setError('');
    try {
      const resp = await apiClient.makeRequest<any>(`/analytics-projects/${selectedIndex.id}/query`, {
        method: 'POST', body: JSON.stringify({
          type: 'natural',
          text: pageOverride !== undefined ? lastNlText : userMsg,
          pageSize: resultPageSize,
          pageOffset: currentPage * resultPageSize,
          source: scope,
          lastQueryResults: truncateRows(rows),
          lastSql: sql,
          history: chatMessages.slice(-40).map(m => ({
            role: m.role, text: m.text
          }))
        })
      });
      // Legacy async path (Athena returned 202+queryExecutionId); MySQL now returns rows directly, so this is skipped.
      if (resp.data?.queryExecutionId && resp.data?.status === 'RUNNING') {
        const generatedSql = resp.data.generatedSql || '';
        if (generatedSql) setSql(generatedSql);
        const explanation = resp.data.explanation || '';
        let pollResp = await pollAthenaQuery(selectedIndex.id, resp.data.queryExecutionId, resultPageSize);

        // Auto-retry: if AI-generated query failed, ask model to fix it
        if (pollResp.data?.status === 'FAILED' && generatedSql) {
          const retryResp = await apiClient.makeRequest<any>(`/analytics-projects/${selectedIndex.id}/query`, {
            method: 'POST', body: JSON.stringify({
              type: 'natural', text: '', pageSize: resultPageSize, pageOffset: currentPage * resultPageSize,
              source: scope,
              lastQueryResults: truncateRows(rows), lastSql: generatedSql,
              history: [
                ...chatMessages.slice(-40).map(m => ({ role: m.role, text: m.text })),
                { role: 'user', text: pageOverride !== undefined ? lastNlText : userMsg },
                { role: 'assistant', text: `I generated: ${generatedSql}` },
                { role: 'user', text: `Error: "${pollResp.data.error}". Fix the SQL.` }
              ]
            })
          });
          if (retryResp.data?.queryExecutionId && retryResp.data?.status === 'RUNNING') {
            if (retryResp.data.generatedSql) setSql(retryResp.data.generatedSql);
            pollResp = await pollAthenaQuery(selectedIndex.id, retryResp.data.queryExecutionId, resultPageSize);
          }
        }

        if (pollResp.data?.status === 'FAILED') throw new Error(pollResp.data.error || 'Query failed');
        if (explanation && pageOverride === undefined) setChatMessages(prev => [...prev, { role: 'assistant', text: explanation }]);
        setRows(pollResp.data.rows || []);
        setColumns(pollResp.data.rows?.length ? Object.keys(pollResp.data.rows[0]) : []);
        setExecutionTimeMs(pollResp.data.executionTimeMs);
        setHasNextPage(pollResp.data.hasNextPage || false);
        setQueryStatus('success'); setLastQueryType('natural');
      } else if (resp.data?.generatedSql) {
        setSql(resp.data.generatedSql);
        const explanation = resp.data.explanation || 'SQL query generated and loaded into the editor.';
        if (pageOverride === undefined) setChatMessages(prev => [...prev, { role: 'assistant', text: explanation }]);
        setRows(resp.data.rows || []);
        setColumns(resp.data.rows?.length ? Object.keys(resp.data.rows[0]) : []);
        setExecutionTimeMs(resp.data.executionTimeMs);
        setHasNextPage(resp.data.hasNextPage || false);
        setQueryStatus('success'); setLastQueryType('natural');
      } else if (resp.data?.answer) {
        setChatMessages(prev => [...prev, { role: 'assistant', text: resp.data.answer }]);
      }
    } catch (e: any) {
      const errMsg = e.message || 'Failed to generate SQL';
      setChatMessages(prev => prev.slice(0, -1)); // remove the user message that caused the error
      setError(errMsg); setQueryStatus('error');
    }
    setGenerating(false);
  };

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [chatMessages]);
  useEffect(() => { if (selectedIndex && chatMessages.length && !activeConversationId) saveChat(selectedIndex.id, chatMessages); }, [chatMessages, selectedIndex, activeConversationId]);
  useEffect(() => { if (selectedIndex && sql) try { localStorage.setItem(sqlStorageKey(selectedIndex.id), sql); } catch {} }, [sql, selectedIndex]);

  const runQuery = async (pageOverride?: number) => {
    if (!selectedIndex || !sql.trim()) return;
    const scope = scopeOfMany(selectedIndexes);
    const currentPage = pageOverride ?? 0;
    if (pageOverride === undefined) setResultPageIndex(1);
    setLoading(true); setError(''); setQueryStatus('idle');
    try {
      const resp = await apiClient.makeRequest<any>(`/analytics-projects/${selectedIndex.id}/query`, {
        method: 'POST', body: JSON.stringify({ type: 'sql', sql, pageSize: resultPageSize, pageOffset: currentPage * resultPageSize, source: scope })
      });
      let data = resp.data || {};
      // Legacy async path (Athena returned 202+queryExecutionId); MySQL now returns rows directly, so this is skipped.
      if (data.queryExecutionId && data.status === 'RUNNING') {
        const pollResp = await pollAthenaQuery(selectedIndex.id, data.queryExecutionId, resultPageSize);
        data = pollResp.data || {};
      }
      setRows(data.rows || []);
      setColumns(data.rows?.length ? Object.keys(data.rows[0]) : []);
      setExecutionTimeMs(data.executionTimeMs);
      setHasNextPage(data.hasNextPage || false);
      setQueryStatus('success'); setLastQueryType('sql');
    } catch (e: any) { setError(e.message || 'Query failed'); setQueryStatus('error'); }
    setLoading(false);
  };

  const onPageChange = async (newPageIndex: number) => {
    setResultPageIndex(newPageIndex);
    const page = newPageIndex - 1; // 0-based
    if (lastQueryType === 'natural') {
      await generateSql(page);
    } else {
      await runQuery(page);
    }
  };

  // Virtual folder assignment handlers.
  // Two ways to identify rows to assign:
  //  (a) the result exposes content_pkey (+ datastore_id) — assigned directly; or
  //  (b) the result exposes any DICOM UID column (studyinstanceuid /
  //      seriesinstanceuid / sopinstanceuid) — the frontend sends those UIDs and
  //      the backend resolves content_pkey server-side (buildSqlFromUids). This
  //      lets a normal analytics query (which selects UIDs, not content_pkey) be
  //      assigned without the user having to add content_pkey.
  const UID_COLS = ['studyinstanceuid', 'seriesinstanceuid', 'sopinstanceuid'];
  const hasContentPkeyCols = columns.includes('datastore_id') && columns.includes('content_pkey');
  const hasUidCols = UID_COLS.some(c => columns.includes(c));
  const hasRequiredVfColumns = hasContentPkeyCols || hasUidCols;

  const openVfModal = async () => {
    // Cannot assign studies from a virtual folder into another virtual folder —
    // only a storage index is a valid assignment source.
    if (selectedIndex?.indexKind === 'vf-index') {
      setError('Studies already in a virtual folder cannot be assigned to another virtual folder. Select a storage index as the source.');
      return;
    }
    if (!hasRequiredVfColumns) {
      setError('Your query must return either content_pkey (with datastore_id) OR a DICOM UID column (StudyInstanceUID / SeriesInstanceUID / SOPInstanceUID) so the results can be assigned to a virtual folder.');
      return;
    }
    setVfError(''); setSuccessMessage(''); setSelectedVf(null); setVfMaxMode('all'); setVfMaxCount('100');
    try {
      const resp = await apiClient.getVirtualFolders({ pageSize: 100 });
      const folders = (resp.data?.items || []).filter((f: any) =>
        f.status === 'ACTIVE' && hasVirtualFolderAccess(f.id, 'canStore')
      );
      setVfList(folders);
    } catch { setVfList([]); }
    setShowVfModal(true);
  };

  const submitVfAssign = async () => {
    if (!selectedIndex || !selectedVf) return;
    setVfSubmitting(true); setVfError('');
    try {
      const maxImagesets = vfMaxMode === 'max' ? parseInt(vfMaxCount) || 100 : null;
      // Send the QUERY, not the rows: the API re-runs it server-side against the
      // full scoped result set (up to the cap) and resolves content_pkey there —
      // whether the query exposes content_pkey directly or only DICOM UID
      // columns. This avoids gathering the selection client-side (which only
      // ever saw the rendered page) and lets the API enqueue the VF indexer.
      const payload: any = { virtualFolderId: selectedVf.value, maxImagesets, source: scopeOfMany(selectedIndexes), sql };
      await apiClient.makeRequest(`/analytics-projects/${selectedIndex.id}/virtual-folder-assign`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setShowVfModal(false);
      setSuccessMessage('Assignment job started. Studies are being added to the virtual folder.');
      setTimeout(() => setSuccessMessage(''), 8000);
    } catch (e: any) { setVfError(e.message || 'Failed to start assignment'); }
    setVfSubmitting(false);
  };

  // Processing job handler. The query itself is the selection, not the rows on
  // screen: the job's expander re-runs it server-side and pages the whole result
  // set, the same way virtual folder assignment does.
  // A processing job runs at SERIES level. It can be started from either:
  //  (a) a result exposing datastore_id + series_instance_uid -> mode:'sql'
  //      (the expander re-runs the query and pages it server-side); or
  //  (b) a result exposing a datastore_id + study/series UID column -> the
  //      frontend builds explicit {datastoreId, studyInstanceUID/seriesInstanceUID}
  //      entries from the rows (the expander expands a study into its series).
  const hasJobSqlCols = columns.includes('datastore_id') && columns.includes('series_instance_uid');
  const hasJobUidCols = columns.includes('datastore_id') &&
    (columns.includes('series_instance_uid') || columns.includes('studyinstanceuid') ||
     columns.includes('seriesinstanceuid') || columns.includes('study_instance_uid'));
  const hasRequiredJobColumns = hasJobSqlCols || hasJobUidCols;

  const openJobModal = () => {
    if (!selectedIndex) return;
    if (!hasRequiredJobColumns) {
      setError('Your query must return datastore_id plus a series/study identifier (series_instance_uid / seriesinstanceuid / studyinstanceuid) to run a processing job on the results.');
      return;
    }
    // Always hand the scheduler the QUERY (mode:'sql'); it re-runs it server-side
    // against the full scoped result set and resolves content_pkeys → tree pkeys
    // → {datastoreId, studyInstanceUID, seriesInstanceUID} entries for the
    // expander. The selection is gathered at the API, never from the rendered page.
    setJobTarget({ mode: 'sql', projectId: selectedIndex.id, sql });
    setShowJobModal(true);
  };

  const resultColumnDefs = columns.length > 0
    ? [
        { id: '_row', header: '#', cell: (item: any) => item._rowNum, width: 50 },
        ...columns.map(col => ({ id: col, header: col, cell: (item: any) => String(item[col] ?? '') }))
      ]
    : [{ id: 'empty', header: 'No columns', cell: () => '' }];

  return (
    <SpaceBetween size="l">
      <Header variant="h1">Analytics Query</Header>

      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      {successMessage && <Alert type="success" dismissible onDismiss={() => setSuccessMessage('')}>{successMessage}</Alert>}

      <div style={{ display: 'flex', gap: 16, width: '100%' }}>
          {/* Editor + results take every pixel the AI rail leaves free. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <SpaceBetween size="m">
              {/* Query scope: storages OR virtual folders, above the editor */}
              <FormField
                label="Storages or virtual folders"
                description={selectedIndexes.length > 1
                  ? `Querying across ${selectedIndexes.length} ${selectedIndex?.indexKind === 'vf-index' ? 'virtual folders' : 'storages'}.`
                  : 'A query can span several storages, or several virtual folders, but not a mix.'}
                stretch
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <Multiselect selectedOptions={selectedIndexes.map(x => ({
                          value: x.id, label: x.name,
                          labelTag: x.indexKind === 'vf-index' ? 'Virtual folder' : 'Storage',
                        }))}
                      onChange={({ detail }) => {
                          const picked = detail.selectedOptions
                            .map(o => indexes.find(x => x.id === o.value))
                            .filter((x): x is AnalyticsIndex => !!x);
                          onSelectIndexes(picked);
                        }}
                        options={[
                          { label: 'Storages', options: indexes.filter(x => x.indexKind !== 'vf-index').map(x => ({ value: x.id, label: x.name, labelTag: 'Storage' })) },
                          { label: 'Virtual folders', options: indexes.filter(x => x.indexKind === 'vf-index').map(x => ({ value: x.id, label: x.name, labelTag: 'Virtual folder' })) },
                        ].filter(g => g.options.length > 0)}
                        filteringType="auto"
                        statusType={indexesLoading ? 'loading' : 'finished'}
                        loadingText="Loading storages / virtual folders…"
                        empty={indexesLoading ? 'Loading…' : 'No storages or virtual folders available'}
                        placeholder="Select one or more storages or virtual folders"
                        tokenLimit={8} />
                  </div>
                  {indexesLoading && <Spinner size="normal" />}
                </div>
              </FormField>

              {selectedIndex && (
                <ExpandableSection headerText="Tables and columns" variant="footer">
                  {/* Live index tables the queries run against (direct MySQL). */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                    {SCHEMA_HINTS.map((t) => (
                      <div key={t.table} className="sql-editor-field-tree">
                        <Box fontWeight="bold" fontSize="body-s">{t.table}</Box>
                        <Box color="text-status-inactive" fontSize="body-s">{t.cols}</Box>
                      </div>
                    ))}
                  </div>
                </ExpandableSection>
              )}

              <SqlEditor value={sql} onChange={setSql} />

              <SpaceBetween direction="horizontal" size="s">
                <Button variant="primary" onClick={() => runQuery()} loading={loading}>Run Query</Button>
                <Button variant="normal" onClick={() => {
                  setSql(defaultSql());
                  setRows([]); setColumns([]); setExecutionTimeMs(null); setQueryStatus('idle');
                }}>Clear</Button>
                {VIRTUAL_FOLDER_ENABLED && (
                  <Button variant="normal" onClick={openVfModal} disabled={queryStatus !== 'success'} iconName="share">
                    Add to Virtual Folder
                  </Button>
                )}
                {canRunJobs && (
                  <Button variant="normal" onClick={openJobModal} disabled={queryStatus !== 'success'} iconName="caret-right-filled">
                    Run Processing Job
                  </Button>
                )}
              </SpaceBetween>

              {queryStatus !== 'idle' && (
                <Box padding={{ vertical: 'xs', horizontal: 's' }}>
                  <SpaceBetween direction="horizontal" size="l">
                    <StatusIndicator type={queryStatus === 'success' ? 'success' : 'error'}>
                      {queryStatus === 'success' ? 'Completed' : 'Failed'}
                    </StatusIndicator>
                    {executionTimeMs !== null && <Box color="text-status-inactive">Run time: {(executionTimeMs / 1000).toFixed(3)} sec</Box>}
                    <Box color="text-status-inactive">Results ({rows.length}{hasNextPage ? '+' : ''})</Box>
                    {resultPageIndex > 1 && <Box color="text-status-inactive">Page {resultPageIndex}</Box>}
                  </SpaceBetween>
                </Box>
              )}

              <Table
                  items={rows.map((r, i) => ({ ...r, _rowNum: ((resultPageIndex - 1) * resultPageSize) + i + 1 }))}
                  columnDefinitions={resultColumnDefs}
                  loading={loading}
                  pagination={
                    rows.length > 0 || resultPageIndex > 1 ? (
                      <Pagination
                        currentPageIndex={resultPageIndex}
                        pagesCount={hasNextPage ? resultPageIndex + 1 : resultPageIndex}
                        openEnd={hasNextPage}
                        onChange={({ detail }) => onPageChange(detail.currentPageIndex)}
                      />
                    ) : undefined
                  }
                  preferences={
                    <CollectionPreferences
                      title="Preferences"
                      confirmLabel="Confirm"
                      cancelLabel="Cancel"
                      pageSizePreference={{
                        title: 'Page size',
                        options: [
                          { value: 10, label: '10 rows' },
                          { value: 25, label: '25 rows' },
                          { value: 50, label: '50 rows' },
                          { value: 100, label: '100 rows' },
                        ]
                      }}
                      preferences={{ pageSize: resultPageSize }}
                      onConfirm={({ detail }) => {
                        setResultPageSize(detail.pageSize || 50);
                        setResultPageIndex(1);
                        setHasNextPage(false);
                      }}
                    />
                  }
                  empty={
                    <Box textAlign="center" color="inherit" padding="l">
                      <b>No results</b>
                      <Box variant="p" color="inherit">Run a query to see results here.</Box>
                    </Box>
                  }
                />
            </SpaceBetween>
          </div>

          {/* Right panel — AI assistant chat rail */}
          {TEXT_TO_SQL && (
            <div style={{
              width: railWidth, flexShrink: 0, position: 'sticky', top: 16, alignSelf: 'flex-start',
              height: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column',
              border: '1px solid var(--color-border-container-top, rgba(255,255,255,0.12))',
              borderRadius: 16, overflow: 'hidden',
              background: 'var(--color-background-container-content, transparent)',
            }}>
              {/* Left-edge drag handle — resize the rail horizontally */}
              <div
                onMouseDown={startRailResize}
                title="Drag to resize"
                style={{
                  position: 'absolute', left: 0, top: 0, bottom: 0, width: 6,
                  cursor: 'col-resize', zIndex: 2,
                  background: 'transparent',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--color-border-item-focused, rgba(0,115,180,0.4))'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              />
              {/* Header */}
              <div style={{
                flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', borderBottom: '1px solid var(--color-border-divider-default, rgba(255,255,255,0.1))',
              }}>
                <Box variant="h3" padding="n">AI Assistant</Box>
                <Button variant="normal" iconName="remove" onClick={resetChat}>Reset chat</Button>
              </div>
              {/* Saved conversations (moved here from the removed left column) */}
              {selectedIndex && (
                <div style={{
                  flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 16px', borderBottom: '1px solid var(--color-border-divider-default, rgba(255,255,255,0.1))',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Select
                      selectedOption={activeConversationId
                        ? { value: activeConversationId, label: conversations.find(c => c.id === activeConversationId)?.title || 'Untitled' }
                        : null}
                      onChange={({ detail }) => { if (detail.selectedOption.value) selectConversation(detail.selectedOption.value); }}
                      options={conversations.map(c => ({ value: c.id, label: c.title || 'Untitled' }))}
                      statusType={conversationsLoading ? 'loading' : 'finished'}
                      loadingText="Loading conversations…"
                      empty="No saved conversations"
                      placeholder={conversations.length ? 'Open a saved conversation' : 'No saved conversations'}
                      filteringType={conversations.length > 8 ? 'auto' : 'none'}
                    />
                  </div>
                  <Button variant="icon" iconName="add-plus" ariaLabel="New conversation" onClick={startNewConversation} />
                  <Button variant="icon" iconName="remove" ariaLabel="Delete this conversation"
                    disabled={!activeConversationId}
                    onClick={() => { if (activeConversationId) deleteConversation(activeConversationId); }} />
                </div>
              )}
              {/* Messages — grow + scroll */}
              <div ref={chatContainerRef} className="sql-editor-chat-area"
                style={{ flex: 1, minHeight: 0, maxHeight: 'none', border: 'none', borderRadius: 0, overflowY: 'auto', padding: '12px 16px' }}>
                {chatMessages.length === 0 && !generating && (
                  <Box color="text-status-inactive" textAlign="center" padding={{ vertical: 'xl' }}>
                    Ask a question about your data and I'll generate the SQL.
                  </Box>
                )}
                <SpaceBetween size="xs">
                  {chatMessages.map((msg, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'
                    }}>
                      <Box padding={{ vertical: 'xs', horizontal: 's' }}>
                        <div className={msg.role === 'user' ? 'sql-editor-chat-bubble-user' : 'sql-editor-chat-bubble-assistant'}>
                          {msg.role === 'assistant' ? (
                            <div className="sql-editor-chat-markdown"><ReactMarkdown>{msg.text}</ReactMarkdown></div>
                          ) : msg.text}
                        </div>
                      </Box>
                    </div>
                  ))}
                  {generating && (
                    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                      <Box padding={{ vertical: 'xs', horizontal: 's' }}>
                        <div className="sql-editor-chat-generating analytics-thinking">
                          <span className="analytics-thinking-icon"><Icon name="gen-ai" /></span>
                          <span>Thinking</span>
                          <span className="analytics-thinking-dots"><i>.</i><i>.</i><i>.</i></span>
                        </div>
                      </Box>
                    </div>
                  )}
                </SpaceBetween>
              </div>
              {/* Input — pinned to the bottom of the rail, Send BELOW the textarea */}
              <div style={{
                flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8,
                padding: '12px 16px', borderTop: '1px solid var(--color-border-divider-default, rgba(255,255,255,0.1))',
              }}>
                <Textarea
                  value={nlText}
                  onChange={({ detail }) => setNlText(detail.value)}
                  placeholder="Ask a question about your data..."
                  rows={2}
                  onKeyDown={(e: any) => {
                    if (e.detail.key === 'Enter' && !e.detail.shiftKey) {
                      e.preventDefault();
                      generateSql();
                    }
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="primary" onClick={() => generateSql()} loading={generating} disabled={!nlText.trim()} iconName="gen-ai">Send</Button>
                </div>
              </div>
            </div>
          )}
        </div>

      {/* Virtual Folder Assignment Modal */}
      <Modal
        visible={showVfModal}
        onDismiss={() => setShowVfModal(false)}
        header="Add to Virtual Folder"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowVfModal(false)}>Cancel</Button>
              <Button variant="primary" loading={vfSubmitting} disabled={!selectedVf || vfSubmitting} onClick={submitVfAssign}>
                Start Assignment
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          {vfError && <Alert type="error">{vfError}</Alert>}
          <FormField label="Virtual Folder" description="Only folders you have write access to are shown">
            <Select
              selectedOption={selectedVf}
              onChange={({ detail }) => setSelectedVf(detail.selectedOption)}
              options={vfList.map(f => ({ value: f.id, label: f.name }))}
              placeholder="Select a virtual folder"
              empty="No writable virtual folders available"
            />
          </FormField>
          <FormField label="Number of studies">
            <RadioGroup
              value={vfMaxMode}
              onChange={({ detail }) => setVfMaxMode(detail.value as 'all' | 'max')}
              items={[
                { value: 'all', label: 'All matching studies' },
                { value: 'max', label: 'Maximum number' },
              ]}
            />
            {vfMaxMode === 'max' && (
              <Box padding={{ top: 's' }}>
                <Input type="number" value={vfMaxCount} onChange={({ detail }) => setVfMaxCount(detail.value)} />
              </Box>
            )}
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Processing Job Modal */}
      <ProcessingJobModal
        visible={showJobModal}
        onDismiss={() => setShowJobModal(false)}
        target={jobTarget}
        targetSummary="Runs on every series returned by the current query."
        onStarted={message => {
          setSuccessMessage(message);
          setTimeout(() => setSuccessMessage(''), 8000);
        }}
      />
    </SpaceBetween>
  );
}
