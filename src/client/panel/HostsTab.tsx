/**
 * Hosts tab: the host table with search (debounced through listHosts),
 * add/edit/delete/test actions, ~/.ssh/config import, and a connect action
 * that hands the alias to the terminal tab via onConnect.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SshApi } from '../api.ts'
import type { SshHostSummary, TestResult } from '../../protocol.ts'
import { errorMessage, tt } from './helpers.ts'
import { HostFormDialog } from './HostFormDialog.tsx'
import { PanelSelect } from './Select.tsx'
import css from './panel.module.css'

/** Hosts tab props. */
export interface HostsTabProps {
  api: SshApi
  /** Connect the given alias in the terminal tab. */
  onConnect: (alias: string) => void
}

/** The host-form dialog invocation. */
type DialogState = { mode: 'create' } | { mode: 'edit'; host: SshHostSummary }

/** Host list grouping modes (#379). */
export type HostGroupBy = 'none' | 'environment' | 'tags'

/** One collapsible group section of the grouped host list. */
export interface HostGroup {
  /** Group key: the environment name, one tag, or '' for the ungrouped bucket. */
  key: string
  hosts: SshHostSummary[]
}

/**
 * Bucket hosts into collapsible groups (#379). Grouping by tags places a
 * multi-tag host in every one of its tag groups (folder view); hosts without
 * the grouping key land in the '' bucket, which always sorts last. Groups
 * sort alphabetically; host order inside a group follows the API listing.
 */
export function groupHosts(hosts: SshHostSummary[], groupBy: HostGroupBy): HostGroup[] {
  if (groupBy === 'none') return [{ key: '', hosts }]
  const buckets = new Map<string, SshHostSummary[]>()
  const push = (key: string, host: SshHostSummary): void => {
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [host])
    else bucket.push(host)
  }
  for (const host of hosts) {
    if (groupBy === 'environment') {
      push(host.environment ?? '', host)
    } else if (host.tags.length === 0) {
      push('', host)
    } else {
      for (const tag of host.tags) push(tag, host)
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([key, group]) => ({ key, hosts: group }))
}

/** Sortable host columns. */
export type HostSortKey = 'alias' | 'host' | 'port' | 'user' | 'auth' | 'jump' | 'environment' | 'tags' | 'description'

/** Every sortable column, in table order (used for the header buttons). */
export const HOST_SORT_KEYS: HostSortKey[] = ['alias', 'host', 'user', 'auth', 'jump', 'environment', 'tags', 'description']

/** Compare two hosts for one sort key. */
function compareHosts(a: SshHostSummary, b: SshHostSummary, key: HostSortKey): number {
  switch (key) {
    case 'alias': return a.alias.localeCompare(b.alias)
    case 'host': return (a.host + ':' + a.port).localeCompare(b.host + ':' + b.port)
    case 'port': return a.port - b.port
    case 'user': return a.user.localeCompare(b.user)
    case 'auth': return a.auth.localeCompare(b.auth)
    case 'jump': return a.proxyJump.join(' → ').localeCompare(b.proxyJump.join(' → '))
    case 'environment': return (a.environment ?? '').localeCompare(b.environment ?? '')
    case 'tags': return a.tags.join(',').localeCompare(b.tags.join(','))
    case 'description': return (a.description ?? '').localeCompare(b.description ?? '')
  }
}

/** Sort a host list by key/direction (ascending by default). */
export function sortHosts(hosts: SshHostSummary[], key: HostSortKey, dir: 'asc' | 'desc'): SshHostSummary[] {
  const factor = dir === 'desc' ? -1 : 1
  return [...hosts].sort((a, b) => compareHosts(a, b, key) * factor)
}

/** The hosts table plus its toolbar and dialogs. */
export function HostsTab({ api, onConnect }: HostsTabProps) {
  const [hosts, setHosts] = useState<SshHostSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [testingAlias, setTestingAlias] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [groupBy, setGroupBy] = useState<HostGroupBy>('none')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [testingGroup, setTestingGroup] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<HostSortKey>('alias')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const seqRef = useRef(0)
  // Unmount guard for the async load below: the seq check only orders
  // overlapping loads, it does not stop a late resolution/rejection landing
  // after the tab unmounted — a setState there races the test-environment
  // teardown (window is not defined; observed as a main-CI flake). The
  // sibling tabs (terminal / transfer / tunnels) already guard with a
  // disposed flag.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  const load = useCallback(async (query?: string): Promise<void> => {
    const seq = ++seqRef.current
    try {
      const list = await api.listHosts(query)
      if (!mountedRef.current || seq !== seqRef.current) return
      setHosts(list)
      setError(null)
    } catch (cause) {
      if (!mountedRef.current || seq !== seqRef.current) return
      setError(errorMessage(cause))
    }
  }, [api])

  useEffect(() => { void load() }, [load])

  // Debounced search: every keystroke re-filters through the API.
  useEffect(() => {
    const timer = setTimeout(() => {
      const query = search.trim()
      void load(query === '' ? undefined : query)
    }, 300)
    return () => { clearTimeout(timer) }
  }, [search, load])

  // Every async setState path guards with mountedRef, not just load(): a
  // promise settling after unmount would setState against the torn-down
  // environment (window is not defined, main-CI flake).
  const runTest = async (alias: string): Promise<void> => {
    if (!mountedRef.current) return
    setTestingAlias(alias)
    try {
      const result = await api.testHost(alias)
      if (!mountedRef.current) return
      setTestResults(prev => ({ ...prev, [alias]: result }))
    } catch (cause) {
      if (!mountedRef.current) return
      setTestResults(prev => ({ ...prev, [alias]: { ok: false, error: errorMessage(cause) } }))
    } finally {
      if (mountedRef.current) setTestingAlias(null)
    }
  }

  const deleteHost = async (alias: string): Promise<void> => {
    if (!window.confirm(tt('hosts.deleteConfirm', { alias }))) return
    try {
      await api.deleteHost(alias)
      if (!mountedRef.current) return
      void load()
    } catch (cause) {
      if (!mountedRef.current) return
      setError(errorMessage(cause))
    }
  }

  /** Toggle one row in the batch selection. */
  const toggleSelected = (alias: string): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  /** Select/deselect every visible host. */
  const toggleAll = (): void => {
    if (hosts === null) return
    setSelected(prev => prev.size === hosts.length ? new Set() : new Set(hosts.map(host => host.alias)))
  }

  /** Batch action: test every selected host. */
  const runBatchTest = async (): Promise<void> => {
    for (const alias of [...selected]) {
      await runTest(alias)
    }
  }

  /** Batch action: delete every selected host (one confirmation). */
  const runBatchDelete = async (): Promise<void> => {
    if (!window.confirm(tt('hosts.batch.deleteConfirm', { count: selected.size }))) return
    const aliases = [...selected]
    for (const alias of aliases) {
      try {
        await api.deleteHost(alias)
      } catch (cause) {
        if (mountedRef.current) setError(errorMessage(cause))
      }
    }
    setSelected(new Set())
    if (mountedRef.current) void load()
  }

  /** Cycle a column's sort direction. */
  const toggleSort = (key: HostSortKey): void => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  // Group-header batch action (#379): test every host in the group.
  const testGroup = async (group: HostGroup): Promise<void> => {
    if (!mountedRef.current) return
    setTestingGroup(group.key)
    try {
      await Promise.all(group.hosts.map(host => runTest(host.alias)))
    } finally {
      if (mountedRef.current) setTestingGroup(null)
    }
  }

  const importConfig = async (): Promise<void> => {
    if (!mountedRef.current) return
    setImporting(true)
    try {
      const result = await api.importSshConfig()
      if (!mountedRef.current) return
      setNotice(tt('hosts.imported', { parsed: result.parsed, added: result.added, skipped: result.skipped }))
      void load()
    } catch (cause) {
      if (!mountedRef.current) return
      setError(errorMessage(cause))
    } finally {
      if (mountedRef.current) setImporting(false)
    }
  }

  const renderHostRow = (host: SshHostSummary): ReactNode => {
    const test = testResults[host.alias]
    return (
      <tr key={host.alias}>
        <td className={css.checkCell}>
          <input
            type="checkbox"
            aria-label={tt('hosts.selectRow', { alias: host.alias })}
            checked={selected.has(host.alias)}
            onChange={() => { toggleSelected(host.alias) }}
          />
        </td>
        <td className={css.mono}>{host.alias}</td>
        <td className={css.mono}>{host.host}:{host.port}</td>
        <td>{host.user}</td>
        <td><span className={css.badge} data-kind={host.auth}>{host.auth === 'key' ? tt('form.auth.key') : host.auth === 'password' ? tt('form.auth.password') : tt('form.auth.agent')}</span></td>
        <td className={css.mono} title={host.proxyJump.join(' → ')}>{host.proxyJump.length > 0 ? host.proxyJump.join(' → ') : '—'}</td>
        <td className={css.cellMuted}>{host.environment ?? ''}</td>
        <td className={css.cellMuted}>{host.tags.join(', ')}</td>
        <td className={css.cellMuted}>{host.description ?? ''}</td>
        <td>
          <div className={css.actions}>
            <button type="button" className={css.linkButton} disabled={testingAlias === host.alias} onClick={() => { void runTest(host.alias) }}>
              {testingAlias === host.alias ? tt('hosts.testing') : tt('hosts.test')}
            </button>
            {testingAlias === host.alias && <span className={css.spinner} aria-hidden="true" />}
            {test !== undefined && (
              <span className={css.inlineTest} data-status={test.ok ? 'ok' : 'fail'}>
                {test.ok ? tt('hosts.testOk', { latency: test.latencyMs ?? 0 }) : tt('hosts.testFail', { error: test.error ?? '' })}
              </span>
            )}
            <button type="button" className={css.linkButton} onClick={() => { setDialog({ mode: 'edit', host }) }}>{tt('hosts.edit')}</button>
            <button type="button" className={css.linkButton} data-danger onClick={() => { void deleteHost(host.alias) }}>{tt('hosts.delete')}</button>
            <button type="button" className={css.ghostButton} onClick={() => { onConnect(host.alias) }}>{tt('hosts.connected')}</button>
          </div>
        </td>
      </tr>
    )
  }

  /** One sortable header cell (click cycles asc/desc). */
  const sortHeader = (key: HostSortKey, label: string): ReactNode => (
    <th>
      <button
        type="button"
        className={css.sortButton}
        data-active={sortKey === key || undefined}
        onClick={() => { toggleSort(key) }}
      >
        {label}
        <span className={css.sortIndicator} data-dir={sortKey === key ? sortDir : undefined} aria-hidden="true">▾</span>
      </button>
    </th>
  )

  const renderHostTable = (rows: SshHostSummary[]): ReactNode => (
    <table className={css.table}>
      <thead>
        <tr>
          <th className={css.checkCell}>
            <input
              type="checkbox"
              aria-label={tt('hosts.selectAll')}
              checked={hosts !== null && hosts.length > 0 && selected.size === hosts.length}
              onChange={() => { toggleAll() }}
            />
          </th>
          {sortHeader('alias', tt('hosts.col.alias'))}
          {sortHeader('host', tt('hosts.col.host'))}
          {sortHeader('user', tt('hosts.col.user'))}
          {sortHeader('auth', tt('hosts.col.auth'))}
          {sortHeader('jump', tt('hosts.col.jump'))}
          {sortHeader('environment', tt('hosts.col.environment'))}
          {sortHeader('tags', tt('hosts.col.tags'))}
          {sortHeader('description', tt('hosts.col.description'))}
          <th>{tt('hosts.col.actions')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(renderHostRow)}
      </tbody>
    </table>
  )

  const sorted = hosts === null ? null : sortHosts(hosts, sortKey, sortDir)
  const groups = sorted === null ? [] : groupHosts(sorted, groupBy)
  const batchCount = selected.size

  return (
    <div className={css.fillBody}>
      <div className={css.toolbar}>
        <input className={css.search} type="search" placeholder={tt('hosts.search')} value={search} onChange={event => { setSearch(event.target.value) }} />
        <PanelSelect
          ariaLabel={tt('hosts.groupBy.label')}
          value={groupBy}
          onChange={value => { setGroupBy(value as HostGroupBy) }}
          options={[
            { value: 'none', label: tt('hosts.groupBy.none') },
            { value: 'environment', label: tt('hosts.groupBy.environment') },
            { value: 'tags', label: tt('hosts.groupBy.tags') },
          ]}
        />
        <div className={css.toolbarSpacer} />
        {batchCount > 0 && (
          <>
            <span className={css.batchCount}>{tt('hosts.batch.selected', { count: batchCount })}</span>
            <button type="button" className={css.ghostButton} disabled={testingAlias !== null} onClick={() => { void runBatchTest() }}>{tt('hosts.batch.test')}</button>
            <button type="button" className={css.ghostButton} data-danger onClick={() => { void runBatchDelete() }}>{tt('hosts.batch.delete')}</button>
          </>
        )}
        <button type="button" className={css.primaryButton} onClick={() => { setDialog({ mode: 'create' }) }}>{tt('hosts.add')}</button>
        <button type="button" className={css.ghostButton} disabled={importing} onClick={() => { void importConfig() }}>{importing ? tt('common.loading') : tt('hosts.import')}</button>
      </div>
      {notice !== null && <div className={css.banner} data-kind="ok">{notice}</div>}
      {error !== null && <div className={css.banner} data-kind="error">{tt('common.error', { error })}</div>}
      {hosts === null && error === null && <div className={css.loading}>{tt('common.loading')}</div>}
      {hosts !== null && hosts.length === 0 && <div className={css.empty}>{tt('hosts.empty')}</div>}
      {sorted !== null && sorted.length > 0 && groupBy === 'none' && (
        <div className={css.tableWrap}>
          {renderHostTable(sorted)}
        </div>
      )}
      {hosts !== null && hosts.length > 0 && groupBy !== 'none' && (
        <div className={css.tableWrap}>
          {groups.map(group => {
            const isCollapsed = collapsed[group.key] === true
            const label = group.key === ''
              ? (groupBy === 'tags' ? tt('hosts.group.noTags') : tt('hosts.group.ungrouped'))
              : group.key
            return (
              <section key={group.key} className={css.groupSection}>
                <div className={css.groupHeader}>
                  <button
                    type="button"
                    className={css.groupToggle}
                    aria-expanded={!isCollapsed}
                    onClick={() => { setCollapsed(prev => ({ ...prev, [group.key]: !isCollapsed })) }}
                  >
                    <span className={css.groupChevron} data-collapsed={isCollapsed || undefined} aria-hidden="true" />
                    <span className={css.groupName}>{label}</span>
                    <span className={css.groupCount}>{tt('hosts.group.count', { count: group.hosts.length })}</span>
                  </button>
                  <button
                    type="button"
                    className={css.linkButton}
                    disabled={testingGroup === group.key}
                    onClick={() => { void testGroup(group) }}
                  >
                    {testingGroup === group.key ? tt('hosts.testing') : tt('hosts.group.testAll')}
                  </button>
                </div>
                {!isCollapsed && renderHostTable(group.hosts)}
              </section>
            )
          })}
        </div>
      )}
      {dialog !== null && (
        <HostFormDialog
          api={api}
          editing={dialog.mode === 'edit' ? dialog.host : null}
          onClose={() => { setDialog(null) }}
          onSaved={() => { setDialog(null); void load() }}
        />
      )}
    </div>
  )
}
