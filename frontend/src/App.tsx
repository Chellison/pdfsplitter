
import React, { useCallback, useRef, useState } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// --- Types ---
interface UploadedDocMeta {
  documentId: string; // documentId from server
  name: string;
  size: number; // bytes
  pages: number;
}

interface Row extends UploadedDocMeta {
  key: string; // local stable key
  split: string; // e.g., "1-3,5"
}

// --- Utils ---
const human = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
};

const isValidSplit = (value: string, max: number) => {
  if (!value.trim()) return false;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  const re = /^(\d+)(-(\d+))?$/;
  for (const p of parts) {
    const m = p.match(re);
    if (!m) return false;
    const a = parseInt(m[1], 10);
    const b = m[3] ? parseInt(m[3], 10) : a;
    if (a < 1 || b < 1 || a > max || b > max || a > b) return false;
  }
  return true;
};

const defaultSplitForPages = (pages: number) => `1-${pages}`;

// --- Sortable Row ---
function SortableRow({ row, onChange, onDelete, onCopy }: {
  row: Row;
  onChange: (key: string, split: string) => void;
  onDelete: (key: string) => void;
  onCopy: (key: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.key });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const valid = isValidSplit(row.split, row.pages);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      title="Drag to reorder"
      className="group grid grid-cols-[20px_1fr_auto_auto_auto] items-center gap-3 border border-neutral-300 bg-white p-4 shadow-sm hover:shadow-md cursor-grab"
    >
      {/* Drag indicator (entire row is draggable) */}
      <div
        className="h-4 w-4 rounded-full border border-neutral-300 bg-neutral-100 text-neutral-500 transition group-hover:bg-neutral-200"
        aria-hidden
      />

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-yellow-400" />
          <div className="truncate font-mono text-lg">{row.name}</div>
        </div>
        <div className="mt-1 flex flex-wrap gap-3 text-sm text-neutral-600 font-mono">
          <span>{human(row.size)}</span>
          <span>•</span>
          <span>{row.pages} page{row.pages === 1 ? "" : "s"}</span>
        </div>
      </div>

      <label className="sr-only" htmlFor={`split-${row.key}`}>Split pattern</label>
      <input
        id={`split-${row.key}`}
        value={row.split}
        onChange={(e) => onChange(row.key, e.target.value)}
        placeholder="e.g., 1-4,10,12-14"
        className={`w-[320px] border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 ${
          valid ? "border-neutral-300 focus:ring-yellow-400" : "border-red-300 focus:ring-red-400"
        }`}
      />

      <button
        onClick={() => onCopy(row.key)}
        className="border border-neutral-300 px-3 py-2 font-mono text-sm hover:bg-neutral-100"
      >
        Copy
      </button>

      <button
        onClick={() => onDelete(row.key)}
        className="border border-red-300 px-3 py-2 font-mono text-sm text-red-600 hover:bg-red-50"
      >
        Delete
      </button>
    </div>
  );
}

// --- Main App ---
export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outputName, setOutputName] = useState<string>("merged.pdf");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  );

  const onDragEnd = (event: any) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = rows.findIndex((r) => r.key === active.id);
      const newIndex = rows.findIndex((r) => r.key === over.id);
      setRows((prev) => arrayMove(prev, oldIndex, newIndex));
    }
  };

  const triggerFile = () => fileInputRef.current?.click();

  const uploadPDF = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", new File([file], file.name, { type: "application/pdf" }));
      const res = await fetch("https://jbarrow--splitter-splitter-app.modal.run/upload", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const meta: UploadedDocMeta = await res.json();
      const newRow: Row = {
        key: crypto.randomUUID(),
        documentId: meta.documentId,
        name: file.name,
        size: meta.size,
        pages: meta.pages,
        split: defaultSplitForPages(meta.pages),
      };
      setRows((r) => [...r, newRow]);
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    await uploadPDF(f);
    // allow re-selecting same file
    e.currentTarget.value = "";
  };

  const onDrop = useCallback(async (ev: React.DragEvent) => {
    ev.preventDefault();
    const file = ev.dataTransfer.files?.[0];
    if (file && file.type === "application/pdf") await uploadPDF(file);
  }, []);

  const onPaste = useCallback(async (ev: React.ClipboardEvent) => {
    const item = Array.from(ev.clipboardData.items).find((i) => i.type === "application/pdf");
    if (item) {
      const file = item.getAsFile();
      if (file) await uploadPDF(file);
    }
  }, []);

  const updateSplit = (key: string, split: string) => setRows((rows) => rows.map((r) => (r.key === key ? { ...r, split } : r)));
  const deleteRow = (key: string) => setRows((rows) => rows.filter((r) => r.key !== key));
  const duplicateRow = (key: string) => {
    setRows((rows) => {
      const index = rows.findIndex((r) => r.key === key);
      if (index === -1) return rows;
      const original = rows[index];
      const copy: Row = { ...original, key: crypto.randomUUID() };
      return [...rows.slice(0, index + 1), copy, ...rows.slice(index + 1)];
    });
  };

  const canGenerate = rows.length > 0 && rows.every((r) => isValidSplit(r.split, r.pages));

  const generate = async () => {
    if (!canGenerate) return;
    setLoading(true);
    setError(null);
    try {
      const payload = {
        filename: outputName || "merged.pdf",
        documents: rows.map((r) => ({ documentId: r.documentId, split: r.split })),
      };
      const res = await fetch("https://jbarrow--splitter-splitter-app.modal.run/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Split failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outputName || "merged.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message || "Split failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f3f3ef] text-neutral-900" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onPaste={onPaste}>
      {/* Header */}
      <header className="mx-auto max-w-5xl px-6 pt-8">
        <div className="mt-6 border-2 border-neutral-900 bg-white p-6 shadow-[6px_6px_0_0_#111]">
          <h1 className="mt-1 font-mono text-3xl">PDF Splitter & Merger</h1>
          <p className="mt-2 max-w-2xl font-mono text-sm text-neutral-700">Upload PDFs, define split ranges per file (e.g., <span className="bg-neutral-100 px-1">1-4,10,12-14</span>), reorder files, and generate a merged download. Drag to reorder. Paste or drop a PDF anywhere.</p>
        </div>
      </header>

      {/* Body */}
      <main className="mx-auto max-w-5xl px-6 pb-20">
        {/* Rows */}
        <div className="mt-8 space-y-3">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
              {rows.map((row) => (
                <SortableRow key={row.key} row={row} onChange={updateSplit} onDelete={deleteRow} onCopy={duplicateRow} />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        {/* Add PDF */}
        <div className="mt-6 flex items-center gap-3">
          <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={onFileChange} />
          <button
            onClick={triggerFile}
            disabled={uploading}
            className={`border border-neutral-300 px-4 py-2 font-mono text-sm shadow-sm ${
              uploading ? "cursor-not-allowed bg-neutral-100 text-neutral-500" : "bg-white hover:bg-neutral-50"
            }`}
          >
            {uploading ? "Working…" : "+ Add PDF"}
          </button>
          <span className="text-xs text-neutral-600 font-mono">or drop/paste a PDF</span>
          {uploading && (
            <span className="ml-2 flex items-center gap-2 font-mono text-xs text-neutral-700">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" />
              Uploading…
            </span>
          )}
        </div>

        {/* Output + Actions */}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <label className="font-mono text-sm" htmlFor="out">Output filename</label>
          <input id="out" value={outputName} onChange={(e) => setOutputName(e.target.value)} className="w-[240px] border border-neutral-300 px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400" />

          <button
            disabled={!canGenerate || loading || uploading}
            onClick={generate}
            className={`border px-5 py-2 font-mono text-sm shadow-sm transition ${
              canGenerate && !loading && !uploading
                ? "border-neutral-900 bg-yellow-300 hover:brightness-95"
                : "cursor-not-allowed border-neutral-200 bg-neutral-100 text-neutral-500"
            }`}
          >
            {loading ? "Generating…" : "Generate Merge"}
          </button>

          {error && <span className="ml-2 font-mono text-sm text-red-600">{error}</span>}
        </div>

        {/* Help card */}
        <div className="mt-10 border border-neutral-300 bg-white p-4 font-mono text-xs text-neutral-700">
          <div className="mb-2 flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-yellow-400" />
            <div className="font-semibold">Tips</div>
          </div>
          <ul className="list-disc space-y-1 pl-6">
            <li>Split syntax supports single pages (<code>3</code>) and ranges (<code>2-5</code>), separated by commas.</li>
            <li>Validation enforces bounds by page count. Red input = invalid.</li>
            <li>Order of rows = order in the final merged file.</li>
          </ul>
        </div>
      </main>

      <footer className="mx-auto max-w-5xl px-6 pb-10 text-center font-mono text-xs text-neutral-500">Built with ♥ by the Joe Barrow</footer>
    </div>
  );
}
