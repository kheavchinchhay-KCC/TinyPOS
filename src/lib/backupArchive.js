const encoder = new TextEncoder();
const decoder = new TextDecoder();

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(bytes) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function write32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function dosTimeDate(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

function normalizeEntry(entry) {
  const nameBytes = encoder.encode(entry.name);
  const data = entry.data instanceof Uint8Array
    ? entry.data
    : encoder.encode(String(entry.data ?? ""));
  return {
    ...entry,
    nameBytes,
    data,
    crc: crc32(data)
  };
}

export function createStoredZip(entries) {
  const normalized = entries.map(normalizeEntry);
  const now = dosTimeDate();
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of normalized) {
    const local = new Uint8Array(30 + entry.nameBytes.length + entry.data.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write16(localView, 10, now.time);
    write16(localView, 12, now.day);
    write32(localView, 14, entry.crc);
    write32(localView, 18, entry.data.length);
    write32(localView, 22, entry.data.length);
    write16(localView, 26, entry.nameBytes.length);
    write16(localView, 28, 0);
    local.set(entry.nameBytes, 30);
    local.set(entry.data, 30 + entry.nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write16(centralView, 8, 0x0800);
    write16(centralView, 10, 0);
    write16(centralView, 12, now.time);
    write16(centralView, 14, now.day);
    write32(centralView, 16, entry.crc);
    write32(centralView, 20, entry.data.length);
    write32(centralView, 24, entry.data.length);
    write16(centralView, 28, entry.nameBytes.length);
    write16(centralView, 30, 0);
    write16(centralView, 32, 0);
    write16(centralView, 34, 0);
    write16(centralView, 36, 0);
    write32(centralView, 38, 0);
    write32(centralView, 42, localOffset);
    central.set(entry.nameBytes, 46);
    centralParts.push(central);

    localOffset += local.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, normalized.length);
  write16(endView, 10, normalized.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, localOffset);
  write16(endView, 20, 0);

  const total = localOffset + centralSize + end.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of localParts) {
    result.set(part, offset);
    offset += part.length;
  }
  for (const part of centralParts) {
    result.set(part, offset);
    offset += part.length;
  }
  result.set(end, offset);
  return result;
}

export function extractStoredZip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= bytes.length) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) {
      throw new Error("This ZIP file is not a supported Tiny POS backup archive.");
    }

    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);

    if (flags & 0x0008) {
      throw new Error("ZIP data descriptors are not supported for Tiny POS backups.");
    }
    if (method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error("Compressed ZIP files are not supported. Choose a Tiny POS backup ZIP.");
    }

    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new Error("The Tiny POS backup ZIP is incomplete or damaged.");
    }

    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataEnd));
    offset = dataEnd;
  }

  return entries;
}

function collectCloudinaryAssets(value, path = "backup", output = [], seen = new Set()) {
  if (value == null) return output;

  if (typeof value === "string") {
    if (/res\.cloudinary\.com\//i.test(value) && !seen.has(value)) {
      seen.add(value);
      output.push({ path, url: value });
    }
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCloudinaryAssets(item, `${path}[${index}]`, output, seen));
    return output;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      collectCloudinaryAssets(item, `${path}.${key}`, output, seen);
    });
  }

  return output;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export function buildBackupArchive(backup) {
  const assets = collectCloudinaryAssets(backup);
  const manifest = {
    format: "tiny-pos-backup-package",
    package_version: 1,
    created_at: backup.created_at,
    source: backup.source,
    business_backup_version: backup.version,
    row_counts: backup.row_counts,
    cloudinary_asset_count: assets.length,
    includes: [
      "Business data used by Tiny POS restore",
      "Staff/profile manifest without passwords",
      "User preferences",
      "Cloudinary asset URL manifest"
    ],
    excludes: [
      "Supabase Auth passwords",
      "Netlify environment secrets",
      "Third-party API secrets",
      "Cloudinary image binary files"
    ]
  };

  const assetCsv = [
    "source_path,cloudinary_url",
    ...assets.map((asset) => `${csvCell(asset.path)},${csvCell(asset.url)}`)
  ].join("\n");

  const readme = [
    "Tiny POS Backup Package",
    "=======================",
    "",
    "business-backup.json is the file used by Tiny POS Restore.",
    "manifest.json describes the package contents.",
    "cloudinary-assets.csv lists Cloudinary URLs referenced by the backup.",
    "",
    "Security exclusions:",
    "- Supabase Auth passwords are never exported.",
    "- Netlify and third-party API secrets are never exported.",
    "- Cloudinary image binaries are not copied into this ZIP; their URLs are listed.",
    ""
  ].join("\n");

  return createStoredZip([
    { name: "business-backup.json", data: JSON.stringify(backup, null, 2) },
    { name: "manifest.json", data: JSON.stringify(manifest, null, 2) },
    { name: "cloudinary-assets.csv", data: assetCsv },
    { name: "README.txt", data: readme }
  ]);
}

export function downloadBackupArchive(backup, filename) {
  const bytes = buildBackupArchive(backup);
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return { size: blob.size };
}

export async function readBusinessBackupArchive(file) {
  if (!file) throw new Error("Choose a Tiny POS backup file.");
  if (file.size > 120 * 1024 * 1024) {
    throw new Error("The backup file is larger than 120 MB.");
  }

  if (file.name.toLowerCase().endsWith(".json")) {
    try {
      return JSON.parse(await file.text());
    } catch {
      throw new Error("The selected JSON backup is invalid.");
    }
  }

  const entries = extractStoredZip(await file.arrayBuffer());
  const backupBytes = entries.get("business-backup.json");
  if (!backupBytes) {
    throw new Error("business-backup.json is missing from this backup ZIP.");
  }

  try {
    return JSON.parse(decoder.decode(backupBytes));
  } catch {
    throw new Error("The backup data inside this ZIP is invalid.");
  }
}
