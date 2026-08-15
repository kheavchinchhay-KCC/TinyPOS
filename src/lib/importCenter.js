const TYPES = {
  products: {
    label: "Products & Opening Stock",
    description:
      "Create products, auto-create categories and add opening stock to new products in the selected branch.",
    required: ["name"],
    headers: [
      "name",
      "name_km",
      "sku",
      "barcode",
      "category",
      "description",
      "unit_name",
      "selling_price",
      "default_cost",
      "currency",
      "track_stock",
      "allow_negative_stock",
      "low_stock_threshold",
      "opening_stock",
      "is_active"
    ],
    sample: {
      name: "Coca-Cola 330ml",
      name_km: "កូកាកូឡា 330ml",
      sku: "P000001",
      barcode: "8851959132012",
      category: "Drinks",
      description: "Can drink",
      unit_name: "Piece",
      selling_price: "0.75",
      default_cost: "0.45",
      currency: "USD",
      track_stock: "true",
      allow_negative_stock: "false",
      low_stock_threshold: "10",
      opening_stock: "100",
      is_active: "true"
    }
  },
  product_units: {
    label: "Product Package Units",
    description:
      "Add or update Box, Pack, Carton and other product units after the products exist.",
    required: ["unit_name", "conversion_factor", "selling_price"],
    requiresOneOf: [["product_sku", "product_barcode"]],
    headers: [
      "product_sku",
      "product_barcode",
      "unit_name",
      "short_name",
      "conversion_factor",
      "selling_price",
      "barcode",
      "sort_order",
      "is_active"
    ],
    sample: {
      product_sku: "P000001",
      product_barcode: "",
      unit_name: "Box",
      short_name: "box",
      conversion_factor: "24",
      selling_price: "16.00",
      barcode: "18851959132019",
      sort_order: "10",
      is_active: "true"
    }
  },
  customers: {
    label: "Customers",
    description:
      "Import customer profiles, customer type, credit limit and optional opening loyalty balance.",
    required: ["name"],
    headers: [
      "customer_code",
      "name",
      "customer_type",
      "company_name",
      "phone",
      "email",
      "address",
      "date_of_birth",
      "credit_limit",
      "loyalty_points",
      "notes",
      "is_active"
    ],
    sample: {
      customer_code: "C000001",
      name: "Sok Dara",
      customer_type: "regular",
      company_name: "",
      phone: "012345678",
      email: "dara@example.com",
      address: "Phnom Penh",
      date_of_birth: "1990-01-15",
      credit_limit: "0",
      loyalty_points: "20",
      notes: "Imported customer",
      is_active: "true"
    }
  },
  suppliers: {
    label: "Suppliers",
    description:
      "Import supplier codes, contacts, tax information and active status.",
    required: ["name"],
    headers: [
      "supplier_code",
      "name",
      "contact_name",
      "phone",
      "email",
      "address",
      "tax_id",
      "notes",
      "is_active"
    ],
    sample: {
      supplier_code: "S000001",
      name: "ABC Wholesale",
      contact_name: "Mr. Vannak",
      phone: "023123456",
      email: "sales@abc.example",
      address: "Phnom Penh",
      tax_id: "K001-123456789",
      notes: "Main supplier",
      is_active: "true"
    }
  }
};

export const importTypes = TYPES;

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadImportTemplate(type) {
  const config = TYPES[type];
  if (!config) throw new Error("Unknown import template.");

  const text = [
    config.headers.map(csvEscape).join(","),
    config.headers
      .map((header) => csvEscape(config.sample[header] ?? ""))
      .join(",")
  ].join("\r\n");

  downloadText(`tiny-pos-${type}-template.csv`, `\ufeff${text}`);
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\ufeff/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (quoted) {
    throw new Error("The CSV contains an unclosed quoted field.");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((values) =>
    values.some((value) => String(value).trim() !== "")
  );

  if (nonEmptyRows.length === 0) {
    throw new Error("The CSV file is empty.");
  }

  const headers = nonEmptyRows[0].map(normalizeHeader);
  if (headers.some((header) => !header)) {
    throw new Error("Every CSV column needs a header.");
  }

  const duplicates = headers.filter(
    (header, index) => headers.indexOf(header) !== index
  );
  if (duplicates.length > 0) {
    throw new Error(`Duplicate CSV header: ${duplicates[0]}`);
  }

  const data = nonEmptyRows.slice(1).map((values, index) => {
    const object = {};
    headers.forEach((header, column) => {
      object[header] = String(values[column] ?? "").trim();
    });
    return {
      rowNumber: index + 2,
      values: object
    };
  });

  return { headers, data };
}

export function validateImport(type, parsed) {
  const config = TYPES[type];
  const errors = [];

  if (!config) return ["Choose an import type."];
  if (parsed.data.length === 0) {
    errors.push("The CSV contains headers but no data rows.");
  }
  if (parsed.data.length > 1000) {
    errors.push("A single import cannot exceed 1,000 rows.");
  }

  for (const header of config.required) {
    if (!parsed.headers.includes(header)) {
      errors.push(`Missing required column: ${header}`);
    }
  }

  for (const group of config.requiresOneOf || []) {
    if (!group.some((header) => parsed.headers.includes(header))) {
      errors.push(`Include at least one column: ${group.join(" or ")}`);
    }
  }

  for (const row of parsed.data) {
    for (const header of config.required) {
      if (!String(row.values[header] || "").trim()) {
        errors.push(`Row ${row.rowNumber}: ${header} is required.`);
      }
    }

    for (const group of config.requiresOneOf || []) {
      if (!group.some((header) => String(row.values[header] || "").trim())) {
        errors.push(
          `Row ${row.rowNumber}: provide ${group.join(" or ")}.`
        );
      }
    }

    if (errors.length >= 30) break;
  }

  return errors;
}

export async function runDataImport(
  supabase,
  type,
  rows,
  duplicateMode,
  fileName
) {
  const { data, error } = await supabase.rpc("run_data_import", {
    p_import_type: type,
    p_rows: rows,
    p_duplicate_mode: duplicateMode,
    p_file_name: fileName || null
  });

  if (error) throw error;
  return data;
}

export async function loadImportHistory(supabase, profile) {
  const { data, error } = await supabase
    .from("data_import_jobs")
    .select(`
      id,
      import_type,
      duplicate_mode,
      file_name,
      status,
      total_rows,
      created_rows,
      updated_rows,
      skipped_rows,
      failed_rows,
      created_by,
      started_at,
      completed_at,
      summary
    `)
    .eq("organization_id", profile.organization_id)
    .order("started_at", { ascending: false })
    .limit(40);

  if (error) throw error;
  return data || [];
}

export function downloadImportErrors(result) {
  const errors = result?.errors || [];
  if (errors.length === 0) return;

  const sourceHeaders = [
    ...new Set(
      errors.flatMap((error) => Object.keys(error.row_data || {}))
    )
  ];
  const headers = ["row_number", "error_message", ...sourceHeaders];
  const lines = [headers.map(csvEscape).join(",")];

  for (const error of errors) {
    lines.push(
      [
        error.row_number,
        error.error_message,
        ...sourceHeaders.map((header) => error.row_data?.[header] ?? "")
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  downloadText(
    `tiny-pos-import-errors-${result.job?.id || "latest"}.csv`,
    `\ufeff${lines.join("\r\n")}`
  );
}

export function importDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
