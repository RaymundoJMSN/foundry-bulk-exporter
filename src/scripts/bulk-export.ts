// ────────────────────────────────────────────────────────────────────
// Bulk export — right-click a Folder (world or compendium) OR a
// whole compendium pack and download every document inside (and
// inside its subfolders, recursively) as a ZIP file. The ZIP mirrors
// the folder hierarchy: each subfolder becomes a directory in the
// archive, each document becomes a JSON file named after it,
// equivalent to Foundry's "Export Data" on a single document.
// ────────────────────────────────────────────────────────────────────

import JSZip from "jszip";
import { MODULE_ID } from "../constants";

interface DirectoryContextEntry {
  name: string;
  icon: string;
  callback: (target: HTMLElement) => void;
  condition?: (target: HTMLElement) => boolean;
}

type AnyDoc = {
  id: string;
  name: string | null;
  folder?: { id: string } | string | null;
  toObject: () => Record<string, unknown>;
};

type AnyFolder = {
  id: string;
  name: string | null;
  pack?: string | null;
  type?: string;
  contents?: AnyDoc[];
  children?: Array<{ folder?: AnyFolder } | AnyFolder>;
  folder?: { id: string } | string | null;
};

type AnyPack = {
  collection?: string;
  metadata?: { label?: string; name?: string; id?: string };
  folders?: { get?: (id: string) => AnyFolder | undefined; contents?: AnyFolder[] };
  getDocuments: () => Promise<AnyDoc[]>;
};

export function registerBulkExport(): void {
  // @ts-expect-error fvtt-types doesn't narrow this hook to our handler shape
  Hooks.on("getFolderContextOptions", onFolderContextOptions);
  Hooks.once("setup", patchCompendiumDirectoryContext);
}

interface CompendiumDirectoryClass {
  prototype: {
    _getEntryContextOptions?: () => DirectoryContextEntry[];
  };
}

function patchCompendiumDirectoryContext(): void {
  const ns = (globalThis as { foundry?: Record<string, unknown> }).foundry;
  const sidebarTabs = (ns?.applications as Record<string, unknown> | undefined)?.sidebar as
    | Record<string, unknown>
    | undefined;
  const tabs = sidebarTabs?.tabs as Record<string, unknown> | undefined;
  const CompendiumDirectory = tabs?.CompendiumDirectory as CompendiumDirectoryClass | undefined;
  if (!CompendiumDirectory?.prototype) {
    console.warn(`[${MODULE_ID}] CompendiumDirectory not found — pack export skipped`);
    return;
  }
  const proto = CompendiumDirectory.prototype;
  const original = proto._getEntryContextOptions;
  if (!original) {
    console.warn(`[${MODULE_ID}] _getEntryContextOptions missing — pack export skipped`);
    return;
  }
  if ((proto._getEntryContextOptions as { _fbePpatched?: boolean })._fbePpatched) return;

  const patched = function (this: unknown): DirectoryContextEntry[] {
    const options = original.call(this) ?? [];
    options.push({
      name: "FBE.UI.ExportCompendiumZip",
      icon: '<i class="fas fa-file-archive"></i>',
      condition: (target) => Boolean(findPackFromTarget(target)),
      callback: (target) => {
        const pack = findPackFromTarget(target);
        if (pack) void exportPackAsZip(pack);
      },
    });
    return options;
  };
  (patched as { _fbePpatched?: boolean })._fbePpatched = true;
  proto._getEntryContextOptions = patched;
  console.log(`[${MODULE_ID}] CompendiumDirectory._getEntryContextOptions patched`);
}

function onFolderContextOptions(_app: unknown, options: DirectoryContextEntry[]): void {
  options.push({
    name: "FBE.UI.ExportFolderZip",
    icon: '<i class="fas fa-file-archive"></i>',
    condition: (target) => Boolean(findFolderFromTarget(target)),
    callback: (target) => {
      const folder = findFolderFromTarget(target);
      if (folder) void exportFolderAsZip(folder);
    },
  });
}

function findFolderFromTarget(target: HTMLElement): AnyFolder | null {
  const el = target.closest<HTMLElement>("[data-folder-id]");
  const id = el?.dataset.folderId;
  if (!id) return null;
  const worldFolder = game.folders?.get(id);
  if (worldFolder) return worldFolder as unknown as AnyFolder;
  const packs = (game.packs?.contents ?? []) as unknown as AnyPack[];
  for (const pack of packs) {
    const cf = pack.folders?.get?.(id);
    if (cf) return cf;
  }
  return null;
}

function findPackFromTarget(target: HTMLElement): AnyPack | null {
  const el =
    target.closest<HTMLElement>("[data-pack]") ??
    target.closest<HTMLElement>("[data-entry-id]");
  if (!el) return null;
  const collection = el.dataset.pack ?? el.dataset.entryId;
  if (!collection) return null;
  return (game.packs?.get(collection) as unknown as AnyPack | undefined) ?? null;
}

function safeFileName(name: string | null | undefined): string {
  const s = (name ?? "untitled").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return s.replace(/^[.\s]+|[.\s]+$/g, "") || "untitled";
}

interface FsAccessSaveOptions {
  suggestedName?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}
interface FsAccessFileHandle {
  createWritable: () => Promise<{
    write: (data: Blob | ArrayBuffer | Uint8Array | string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}
type ShowSaveFilePicker = (opts: FsAccessSaveOptions) => Promise<FsAccessFileHandle>;

async function downloadBlobAs(blob: Blob, filename: string): Promise<void> {
  const wrapped =
    blob.type === "application/zip"
      ? blob
      : new Blob([blob], { type: "application/zip" });

  const showSave = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker;
  if (typeof showSave === "function") {
    try {
      const handle = await showSave({
        suggestedName: filename,
        types: [
          {
            description: "ZIP archive",
            accept: { "application/zip": [".zip"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(wrapped);
      await writable.close();
      return;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      console.warn(`[${MODULE_ID}] showSaveFilePicker failed, falling back to anchor`, err);
    }
  }

  const url = URL.createObjectURL(wrapped);
  const a = document.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("download", filename);
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

async function exportFolderAsZip(folder: AnyFolder): Promise<void> {
  const zip = new JSZip();
  const rootName = safeFileName(folder.name);
  const root = zip.folder(rootName) ?? zip;

  ui.notifications?.info(
    game.i18n!.format("FBE.Notify.ExportingFolder", { name: folder.name ?? "" }),
  );

  try {
    const packDocsCache = new Map<string, AnyDoc[]>();
    await walkFolder(folder, root, packDocsCache);

    const blob = await zip.generateAsync({ type: "blob" });
    await downloadBlobAs(blob, `${rootName}.zip`);

    ui.notifications?.info(
      game.i18n!.format("FBE.Notify.ExportedFolder", { name: folder.name ?? "" }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${MODULE_ID}] bulk export failed`, err);
    ui.notifications?.error(
      game.i18n!.format("FBE.Notify.ExportFolderFailed", { error: msg }),
    );
  }
}

async function walkFolder(
  folder: AnyFolder,
  zipFolder: JSZip,
  packDocsCache: Map<string, AnyDoc[]>,
): Promise<void> {
  const docs = await getDocumentsInFolder(folder, packDocsCache);
  const usedNames = new Set<string>();
  for (const doc of docs) {
    const fname = uniqueName(safeFileName(doc.name), usedNames);
    const json = JSON.stringify(doc.toObject(), null, 2);
    zipFolder.file(`${fname}.json`, json);
  }

  const children = (folder.children ?? []) as Array<{ folder?: AnyFolder } | AnyFolder>;
  const usedSubNames = new Set<string>();
  for (const childEntry of children) {
    const child = (childEntry as { folder?: AnyFolder }).folder ?? (childEntry as AnyFolder);
    if (!child || !child.id) continue;
    const subName = uniqueName(safeFileName(child.name), usedSubNames);
    const childZip = zipFolder.folder(subName);
    if (!childZip) continue;
    await walkFolder(child, childZip, packDocsCache);
  }
}

async function getDocumentsInFolder(
  folder: AnyFolder,
  cache: Map<string, AnyDoc[]>,
): Promise<AnyDoc[]> {
  if (folder.pack) {
    let all = cache.get(folder.pack);
    if (!all) {
      const pack = game.packs?.get(folder.pack) as unknown as AnyPack | undefined;
      all = pack ? await pack.getDocuments() : [];
      cache.set(folder.pack, all);
    }
    return all.filter((d) => docFolderId(d) === folder.id);
  }
  return folder.contents ?? [];
}

async function exportPackAsZip(pack: AnyPack): Promise<void> {
  const label = pack.metadata?.label ?? pack.metadata?.name ?? "compendium";
  const rootName = safeFileName(label);
  const zip = new JSZip();
  const root = zip.folder(rootName) ?? zip;

  ui.notifications?.info(
    game.i18n!.format("FBE.Notify.ExportingFolder", { name: label }),
  );

  try {
    const allDocs = await pack.getDocuments();

    const allFolders = (pack.folders?.contents ?? []) as AnyFolder[];
    const childrenByParent = new Map<string | null, AnyFolder[]>();
    for (const f of allFolders) {
      const parentId = folderParentId(f);
      const arr = childrenByParent.get(parentId) ?? [];
      arr.push(f);
      childrenByParent.set(parentId, arr);
    }

    const docsByFolder = new Map<string | null, AnyDoc[]>();
    for (const d of allDocs) {
      const fid = docFolderId(d);
      const arr = docsByFolder.get(fid) ?? [];
      arr.push(d);
      docsByFolder.set(fid, arr);
    }

    writePackNode(root, null, childrenByParent, docsByFolder);

    const blob = await zip.generateAsync({ type: "blob" });
    await downloadBlobAs(blob, `${rootName}.zip`);

    ui.notifications?.info(
      game.i18n!.format("FBE.Notify.ExportedFolder", { name: label }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${MODULE_ID}] compendium export failed`, err);
    ui.notifications?.error(
      game.i18n!.format("FBE.Notify.ExportFolderFailed", { error: msg }),
    );
  }
}

function writePackNode(
  zipFolder: JSZip,
  parentId: string | null,
  childrenByParent: Map<string | null, AnyFolder[]>,
  docsByFolder: Map<string | null, AnyDoc[]>,
): void {
  const usedFiles = new Set<string>();
  for (const d of docsByFolder.get(parentId) ?? []) {
    const fname = uniqueName(safeFileName(d.name), usedFiles);
    zipFolder.file(`${fname}.json`, JSON.stringify(d.toObject(), null, 2));
  }
  const usedDirs = new Set<string>();
  for (const child of childrenByParent.get(parentId) ?? []) {
    const dirName = uniqueName(safeFileName(child.name), usedDirs);
    const sub = zipFolder.folder(dirName);
    if (!sub) continue;
    writePackNode(sub, child.id, childrenByParent, docsByFolder);
  }
}

function docFolderId(d: AnyDoc): string | null {
  const f = d.folder;
  if (!f) return null;
  return typeof f === "string" ? f : (f.id ?? null);
}

function folderParentId(f: AnyFolder): string | null {
  const p = f.folder;
  if (!p) return null;
  return typeof p === "string" ? p : (p.id ?? null);
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 1;
  while (used.has(name)) name = `${base} (${++n})`;
  used.add(name);
  return name;
}
