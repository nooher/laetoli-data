import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { AdminApi, ApiError } from '../api';
import type { Column, Row, SchemaResponse, TableInfo, TableRows } from '../types';
import {
  buildWhereFromRow,
  coerceInput,
  formatCell,
  hasPrimaryKey,
  isNullish,
  toInputString,
} from '../lib';
import { Loading, TableSkeleton, ErrorBanner, Empty, Modal, Toast } from '../components/ui';
import { IconPlus, IconEdit, IconTrash } from '../icons';

const PAGE = 50;

export function TableEditor({ api }: { api: AdminApi }): JSX.Element {
  const [schema, setSchema] = useState<SchemaResponse | null>(null);
  const [schemaErr, setSchemaErr] = useState<string | null>(null);
  const [sel, setSel] = useState<{ schema: string; table: string } | null>(null);

  useEffect(() => {
    let active = true;
    api.schema().then(
      (s) => {
        if (!active) return;
        setSchema(s);
        const first = s.schemas.find((sc) => sc.tables.length > 0);
        if (first) setSel({ schema: first.name, table: first.tables[0].name });
      },
      (e: unknown) => active && setSchemaErr(e instanceof ApiError ? e.message : 'Failed to load schema.'),
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (schemaErr) return <ErrorBanner message={schemaErr} />;
  if (!schema) return <Loading label="Reading schema…" />;
  if (schema.schemas.every((s) => s.tables.length === 0))
    return <Empty title="No tables found" hint="This backend has no tables in the exposed schemas yet." />;

  const currentSchema = schema.schemas.find((s) => s.name === sel?.schema);
  const currentTable = currentSchema?.tables.find((t) => t.name === sel?.table);

  return (
    <>
      <div className="toolbar">
        <div className="inline-sel">
          <label htmlFor="schemaSel">Schema</label>
          <select
            id="schemaSel"
            value={sel?.schema ?? ''}
            onChange={(e) => {
              const sc = schema.schemas.find((s) => s.name === e.target.value);
              if (sc && sc.tables.length) setSel({ schema: sc.name, table: sc.tables[0].name });
            }}
          >
            {schema.schemas.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-sel">
          <label htmlFor="tableSel">Table / view</label>
          <select
            id="tableSel"
            value={sel?.table ?? ''}
            onChange={(e) => sel && setSel({ schema: sel.schema, table: e.target.value })}
          >
            {currentSchema?.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.kind === 'view' ? ' (view)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {sel && currentTable ? (
        <RowsPanel
          key={`${sel.schema}.${sel.table}`}
          api={api}
          schema={sel.schema}
          table={currentTable}
        />
      ) : null}
    </>
  );
}

function RowsPanel({
  api,
  schema,
  table,
}: {
  api: AdminApi;
  schema: string;
  table: TableInfo;
}): JSX.Element {
  const columns = table.columns;
  const [data, setData] = useState<TableRows | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const isView = table.kind === 'view';
  const editable = hasPrimaryKey(columns) && !isView;

  const order = useMemo(() => {
    const pk = columns.find((c) => c.is_pk);
    return pk ? pk.name : undefined;
  }, [columns]);

  function load() {
    let active = true;
    setLoading(true);
    setError(null);
    api.tableRows(schema, table.name, { limit: PAGE, offset, order }).then(
      (d) => active && (setData(d), setLoading(false)),
      (e: unknown) => active && (setError(e instanceof ApiError ? e.message : 'Failed to load rows.'), setLoading(false)),
    );
    return () => {
      active = false;
    };
  }

  useEffect(load, [api, schema, table.name, offset, order]);

  async function doDelete(row: Row) {
    const where = buildWhereFromRow(columns, row);
    if (!where) return;
    if (!confirm('Delete this row? This cannot be undone.')) return;
    try {
      await api.deleteRow(schema, table.name, where);
      setOk('Row deleted.');
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed.');
    }
  }

  const count = data?.count ?? 0;
  const showingFrom = count === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE, count);

  return (
    <>
      <div className="spread" style={{ marginBottom: 14 }}>
        <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
          {isView ? 'Read-only view' : editable ? 'Editable table' : 'No primary key — read-only'} ·{' '}
          {columns.length} columns
        </p>
        <button
          className="btn btn-green btn-sm"
          onClick={() => setAdding(true)}
          disabled={isView}
          title={isView ? 'Views are read-only' : 'Insert a new row'}
        >
          <IconPlus className="nav-ico" /> Add row
        </button>
      </div>

      {error ? <ErrorBanner message={error} /> : null}
      {ok ? <Toast message={ok} onClose={() => setOk(null)} /> : null}

      {loading ? (
        <TableSkeleton columns={columns.length + (editable ? 1 : 0)} label="Loading rows…" />
      ) : !data || data.rows.length === 0 ? (
        <Empty title="No rows" hint="This table is empty." />
      ) : (
        <>
          <div className="table-scroll">
            <table className="grid">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.name}>
                      <span className="th-name">
                        {c.name}
                        {c.is_pk ? <span className="pill pill-pk th-pk">PK</span> : null}
                      </span>
                      <span className="coltype">{c.type}</span>
                    </th>
                  ))}
                  {editable ? <th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td
                        key={c.name}
                        className={`cell-val${isNullish(row[c.name]) ? ' null' : ''}`}
                        title={isNullish(row[c.name]) ? 'null' : formatCell(row[c.name])}
                      >
                        {formatCell(row[c.name])}
                      </td>
                    ))}
                    {editable ? (
                      <td>
                        <div className="row-actions">
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setEditing(row)}
                            aria-label="Edit row"
                          >
                            <IconEdit className="nav-ico" />
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            onClick={() => doDelete(row)}
                            aria-label="Delete row"
                          >
                            <IconTrash className="nav-ico" />
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button
              className="btn btn-ghost btn-sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              ← Prev
            </button>
            <span>
              {showingFrom}–{showingTo} of {count.toLocaleString()}
            </span>
            <button
              className="btn btn-ghost btn-sm"
              disabled={showingTo >= count}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next →
            </button>
          </div>
        </>
      )}

      {(editing || adding) && (
        <RowForm
          mode={adding ? 'insert' : 'update'}
          columns={columns}
          row={editing ?? undefined}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSubmit={async (values) => {
            try {
              if (adding) {
                await api.insertRow(schema, table.name, values);
                setOk('Row inserted.');
              } else if (editing) {
                const where = buildWhereFromRow(columns, editing);
                if (!where) throw new Error('Cannot identify this row (no primary key).');
                await api.updateRow(schema, table.name, where, values);
                setOk('Row updated.');
              }
              setEditing(null);
              setAdding(false);
              load();
            } catch (e) {
              throw e instanceof ApiError ? new Error(e.message) : e;
            }
          }}
        />
      )}
    </>
  );
}

function RowForm({
  mode,
  columns,
  row,
  onClose,
  onSubmit,
}: {
  mode: 'insert' | 'update';
  columns: Column[];
  row?: Row;
  onClose: () => void;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of columns) init[c.name] = toInputString(row?.[c.name]);
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const out: Record<string, unknown> = {};
      for (const c of columns) {
        const raw = values[c.name] ?? '';
        // On insert, skip empty fields with a default / serial pk so the DB fills them.
        if (mode === 'insert' && raw.trim() === '' && (c.is_pk || c.default !== null)) continue;
        out[c.name] = coerceInput(raw);
      }
      await onSubmit(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={mode === 'insert' ? 'Insert row' : 'Edit row'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : mode === 'insert' ? 'Insert' : 'Save changes'}
          </button>
        </>
      }
    >
      {err ? <ErrorBanner message={err} /> : null}
      <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
        Empty = NULL. <code>true</code>/<code>false</code>/numbers and{' '}
        <code>{'{...}'}</code>/<code>[...]</code> JSON are parsed automatically.
      </p>
      {columns.map((c) => (
        <div className="field" key={c.name}>
          <label htmlFor={`f-${c.name}`}>
            {c.name}{' '}
            <span className="pill pill-type">{c.type}</span>
            {c.is_pk ? <span className="pill pill-pk" style={{ marginLeft: 6 }}>PK</span> : null}
          </label>
          <input
            id={`f-${c.name}`}
            type="text"
            value={values[c.name] ?? ''}
            onChange={(e) => setValues({ ...values, [c.name]: e.target.value })}
            placeholder={c.default ? `default: ${c.default}` : c.nullable ? 'null' : ''}
          />
        </div>
      ))}
    </Modal>
  );
}
