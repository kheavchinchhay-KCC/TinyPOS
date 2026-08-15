import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileDown,
  FileSpreadsheet,
  History,
  PackagePlus,
  RefreshCw,
  UploadCloud,
  UsersRound,
  Warehouse
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import ImportDropzone from "../components/ImportDropzone";
import ImportPreviewTable from "../components/ImportPreviewTable";
import {
  downloadImportErrors,
  downloadImportTemplate,
  importDateTime,
  importTypes,
  loadImportHistory,
  parseCsv,
  runDataImport,
  validateImport
} from "../lib/importCenter";

const icons = {
  products: Warehouse,
  product_units: PackagePlus,
  customers: UsersRound,
  suppliers: FileSpreadsheet
};

const duplicateModes = [
  ["skip", "Skip existing", "Existing matches stay unchanged."],
  ["update", "Update existing", "Matching profiles are updated. Product opening stock is used only for new products."],
  ["error", "Report as error", "Every duplicate row is listed as failed."]
];

export default function ImportCenterPage() {
  const { supabase, profile, can } = useAuth();
  const canImport = can("import.manage");

  const [type, setType] = useState("products");
  const [duplicateMode, setDuplicateMode] = useState("skip");
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState({ headers: [], data: [] });
  const [validationErrors, setValidationErrors] = useState([]);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState("success");

  const config = importTypes[type];

  const refreshHistory = useCallback(async () => {
    if (!supabase || !profile?.organization_id || !canImport) return;
    try {
      setLoadingHistory(true);
      setHistory(await loadImportHistory(supabase, profile));
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setLoadingHistory(false);
    }
  }, [supabase, profile, canImport]);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    setFile(null);
    setParsed({ headers: [], data: [] });
    setValidationErrors([]);
    setResult(null);
    setMessage("");
  }, [type]);

  const ready = useMemo(
    () => parsed.data.length > 0 && validationErrors.length === 0,
    [parsed.data.length, validationErrors.length]
  );

  async function handleFile(nextFile) {
    setFile(nextFile);
    setResult(null);
    setMessage("");

    if (!nextFile.name.toLowerCase().endsWith(".csv")) {
      setParsed({ headers: [], data: [] });
      setValidationErrors(["Choose a .csv file."]);
      return;
    }

    try {
      const nextParsed = parseCsv(await nextFile.text());
      setParsed(nextParsed);
      setValidationErrors(validateImport(type, nextParsed));
    } catch (error) {
      setParsed({ headers: [], data: [] });
      setValidationErrors([error.message]);
    }
  }

  async function handleImport() {
    if (!ready || !file) return;

    try {
      setBusy(true);
      setMessage("");
      const response = await runDataImport(
        supabase,
        type,
        parsed.data.map((row) => row.values),
        duplicateMode,
        file.name
      );
      setResult(response);
      setMessageType(response.job?.failed_rows > 0 ? "warning" : "success");
      setMessage(
        response.job?.failed_rows > 0
          ? "Import finished with row errors. Review or download the error list below."
          : "Import completed successfully."
      );
      await refreshHistory();
    } catch (error) {
      setMessageType("error");
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (!canImport) {
    return (
      <section className="panel empty-state">
        <UploadCloud size={46} />
        <h2>Owner or admin access required</h2>
        <p>Bulk imports can change important business records and are restricted to owner and admin accounts.</p>
      </section>
    );
  }

  return (
    <div className="page-stack import-center-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">DATA MIGRATION</p>
          <h1>Import Center</h1>
          <p className="muted">
            Import structured CSV files into the new Tiny POS project without changing the old POS.
          </p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={refreshHistory}
          disabled={loadingHistory}
        >
          <RefreshCw size={18} className={loadingHistory ? "spin" : ""} />
          Refresh history
        </button>
      </div>

      {message && (
        <div className={`notice ${messageType}`} onClick={() => setMessage("")}>
          {message}
        </div>
      )}

      <section className="import-type-grid">
        {Object.entries(importTypes).map(([value, item]) => {
          const Icon = icons[value];
          return (
            <button
              type="button"
              key={value}
              className={type === value ? "active" : ""}
              onClick={() => setType(value)}
              disabled={busy}
            >
              <Icon size={23} />
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </button>
          );
        })}
      </section>

      <section className="panel import-workspace-panel">
        <div className="import-workspace-heading">
          <div>
            <p className="eyebrow">STEP 1</p>
            <h2>Prepare the {config.label} CSV</h2>
            <p className="muted">Download the template, preserve the header row and save the completed file as CSV UTF-8.</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => downloadImportTemplate(type)}
          >
            <FileDown size={18} />
            Download template
          </button>
        </div>

        <div className="import-template-fields">
          <strong>Template columns</strong>
          <div>
            {config.headers.map((header) => (
              <span key={header}>{header}</span>
            ))}
          </div>
        </div>

        <ImportDropzone file={file} disabled={busy} onFile={handleFile} />

        {validationErrors.length > 0 && (
          <div className="import-validation-errors">
            <AlertTriangle size={21} />
            <div>
              <strong>Fix the CSV before importing</strong>
              {validationErrors.slice(0, 30).map((error) => (
                <span key={error}>{error}</span>
              ))}
            </div>
          </div>
        )}

        {parsed.data.length > 0 && (
          <>
            <div className="import-file-summary">
              <div>
                <span>Data rows</span>
                <strong>{parsed.data.length.toLocaleString("en-US")}</strong>
              </div>
              <div>
                <span>Columns</span>
                <strong>{parsed.headers.length}</strong>
              </div>
              <div>
                <span>Validation</span>
                <strong>{validationErrors.length === 0 ? "Ready" : `${validationErrors.length} issue(s)`}</strong>
              </div>
            </div>

            <div className="import-preview-heading">
              <div>
                <p className="eyebrow">STEP 2</p>
                <h2>Review the CSV preview</h2>
              </div>
            </div>

            <ImportPreviewTable headers={parsed.headers} rows={parsed.data} />

            <div className="import-execution-grid">
              <section>
                <p className="eyebrow">STEP 3</p>
                <h2>Choose duplicate behavior</h2>
                <div className="import-duplicate-options">
                  {duplicateModes.map(([value, label, detail]) => (
                    <label className={duplicateMode === value ? "active" : ""} key={value}>
                      <input
                        type="radio"
                        name="duplicate-mode"
                        value={value}
                        checked={duplicateMode === value}
                        onChange={(event) => setDuplicateMode(event.target.value)}
                      />
                      <span>
                        <strong>{label}</strong>
                        <small>{detail}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section className="import-run-panel">
                <UploadCloud size={31} />
                <h2>Run import</h2>
                <p>
                  The import runs inside a secure database transaction and records every failed row separately.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleImport}
                  disabled={!ready || busy}
                >
                  <UploadCloud size={18} />
                  {busy ? "Importing rows..." : `Import ${parsed.data.length.toLocaleString("en-US")} rows`}
                </button>
              </section>
            </div>
          </>
        )}
      </section>

      {result?.job && (
        <section className="panel import-result-panel">
          <div className="panel-title-row">
            <div>
              <p className="eyebrow">LATEST RESULT</p>
              <h2>{result.job.file_name || config.label}</h2>
            </div>
            {result.job.failed_rows > 0 ? <AlertTriangle size={23} /> : <CheckCircle2 size={23} />}
          </div>

          <div className="import-result-metrics">
            <article><span>Total</span><strong>{result.job.total_rows}</strong></article>
            <article><span>Created</span><strong>{result.job.created_rows}</strong></article>
            <article><span>Updated</span><strong>{result.job.updated_rows}</strong></article>
            <article><span>Skipped</span><strong>{result.job.skipped_rows}</strong></article>
            <article className={result.job.failed_rows ? "failed" : ""}><span>Failed</span><strong>{result.job.failed_rows}</strong></article>
          </div>

          {result.errors?.length > 0 && (
            <>
              <div className="import-error-toolbar">
                <div>
                  <strong>Row errors</strong>
                  <span>Correct these rows and import them again.</span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => downloadImportErrors(result)}
                >
                  <Download size={18} />
                  Download errors CSV
                </button>
              </div>

              <div className="import-error-list">
                {result.errors.slice(0, 100).map((error) => (
                  <article key={`${error.row_number}-${error.error_message}`}>
                    <b>CSV row {Number(error.row_number)}</b>
                    <span>{error.error_message}</span>
                    <code>{JSON.stringify(error.row_data)}</code>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <section className="panel import-history-panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">HISTORY</p>
            <h2>Import jobs</h2>
          </div>
          <History size={22} />
        </div>

        {loadingHistory ? (
          <div className="empty-state compact"><RefreshCw className="spin" /><p>Loading import history...</p></div>
        ) : history.length === 0 ? (
          <div className="empty-state compact"><FileSpreadsheet size={42} /><p>No import jobs yet.</p></div>
        ) : (
          <div className="import-history-list">
            {history.map((job) => (
              <article key={job.id}>
                <div>
                  <strong>{importTypes[job.import_type]?.label || job.import_type}</strong>
                  <span>{job.file_name || "Unnamed CSV"} · {importDateTime(job.started_at)}</span>
                </div>
                <span className={`status-pill ${job.failed_rows > 0 ? "inactive" : "active"}`}>
                  {String(job.status).replaceAll("_", " ")}
                </span>
                <div className="import-history-counts">
                  <span>{job.created_rows} created</span>
                  <span>{job.updated_rows} updated</span>
                  <span>{job.skipped_rows} skipped</span>
                  <span>{job.failed_rows} failed</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
