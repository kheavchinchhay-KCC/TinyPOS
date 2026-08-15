import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { useRef, useState } from "react";

export default function ImportDropzone({ file, disabled, onFile }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function accept(files) {
    const next = files?.[0];
    if (!next) return;
    onFile(next);
  }

  return (
    <section
      className={`import-dropzone ${dragging ? "dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) accept(event.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        disabled={disabled}
        onChange={(event) => accept(event.target.files)}
      />

      {file ? <FileSpreadsheet size={42} /> : <UploadCloud size={46} />}

      <div>
        <h3>{file ? file.name : "Drop a CSV file here"}</h3>
        <p>
          {file
            ? `${(file.size / 1024).toLocaleString("en-US", {
                maximumFractionDigits: 1
              })} KB`
            : "Use the matching Tiny POS template for the selected import type."}
        </p>
      </div>

      <button
        type="button"
        className="secondary-button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        {file ? "Choose another CSV" : "Choose CSV file"}
      </button>
    </section>
  );
}
