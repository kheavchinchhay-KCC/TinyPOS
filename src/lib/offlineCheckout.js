const DB_NAME = "tiny-pos-offline-v42";
const DB_VERSION = 1;
const BUNDLE_STORE = "bundles";
const SALE_STORE = "sales";
const AUTH_KEY_PREFIX = "tiny-pos-offline-auth:";
const DEVICE_ID_KEY = "tiny-pos-offline-device-id";
const DEVICE_NAME_KEY = "tiny-pos-offline-device-name";
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BUNDLE_STORE)) {
        db.createObjectStore(BUNDLE_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(SALE_STORE)) {
        const store = db.createObjectStore(SALE_STORE, { keyPath: "offline_sale_id" });
        store.createIndex("profile_key", "profile_key", { unique: false });
        store.createIndex("status", "status", { unique: false });
        store.createIndex("created_at", "offline_created_at", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open offline storage."));
  });
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Offline storage request failed."));
  });
}

async function withStore(storeName, mode, action) {
  if (typeof indexedDB === "undefined") {
    throw new Error("This browser does not support secure offline storage.");
  }

  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = await action(store);
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Offline storage transaction failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Offline storage transaction was cancelled."));
    });
    return result;
  } finally {
    db.close();
  }
}

export function offlineProfileKey(profile) {
  if (!profile?.organization_id || !profile?.branch_id || !profile?.id) return null;
  return [profile.organization_id, profile.branch_id, profile.id].join(":");
}

function bundleKey(profile) {
  const key = offlineProfileKey(profile);
  return key ? `bundle:${key}` : null;
}

export function createOfflineId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getOfflineDevice() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = createOfflineId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }

  const fallback = `${navigator.platform || "POS"} · ${navigator.userAgent.includes("Mobile") ? "Mobile" : "Browser"}`;
  const name = localStorage.getItem(DEVICE_NAME_KEY) || fallback;
  return { id, name };
}

export function setOfflineDeviceName(name) {
  const clean = String(name || "").trim().slice(0, 120);
  if (!clean) throw new Error("Device name is required.");
  localStorage.setItem(DEVICE_NAME_KEY, clean);
  return getOfflineDevice();
}

export async function prepareOfflineCheckout(supabase, profile, values = {}) {
  const existing = await listOfflineSales(profile);
  const unresolved = existing.filter((sale) => ["pending", "syncing", "conflict"].includes(sale.status));
  if (unresolved.length > 0) {
    throw new Error(`Synchronize or resolve ${unresolved.length} offline sale(s) before preparing a new bundle.`);
  }

  for (const sale of existing.filter((row) => row.status === "synced")) {
    await deleteOfflineSale(sale.offline_sale_id);
  }

  const device = getOfflineDevice();
  const deviceName = String(values.device_name || device.name).trim();
  setOfflineDeviceName(deviceName);

  const { data, error } = await supabase.rpc("prepare_offline_checkout_session", {
    p_device_id: device.id,
    p_device_name: deviceName,
    p_valid_hours: Number(values.valid_hours || 24)
  });

  if (error) throw error;
  await saveOfflineCheckoutBundle(profile, data);
  return data;
}

export async function saveOfflineCheckoutBundle(profile, bundle) {
  const key = bundleKey(profile);
  if (!key) throw new Error("Active POS profile is required.");

  const record = {
    key,
    profile_key: offlineProfileKey(profile),
    saved_at: new Date().toISOString(),
    ...bundle
  };

  await withStore(BUNDLE_STORE, "readwrite", async (store) => {
    await requestPromise(store.put(record));
  });
  emit();
  return record;
}

export async function loadOfflineCheckoutBundle(profile) {
  const key = bundleKey(profile);
  if (!key) return null;
  return withStore(BUNDLE_STORE, "readonly", (store) => requestPromise(store.get(key)));
}

export function offlineBundleExpired(bundle) {
  const expiresAt = bundle?.session?.expires_at;
  return !expiresAt || new Date(expiresAt).getTime() <= Date.now();
}

function normalizeSnapshotProduct(product) {
  const images = [...(product.product_images || [])].sort(
    (a, b) => Number(b.is_primary) - Number(a.is_primary) || Number(a.sort_order || 0) - Number(b.sort_order || 0)
  );
  const units = [...(product.product_units || [])]
    .filter((unit) => unit.is_active || unit.is_base)
    .sort(
      (a, b) => Number(b.is_base) - Number(a.is_base) || Number(a.sort_order || 0) - Number(b.sort_order || 0)
    );

  return {
    ...product,
    product_units: units,
    units,
    image: images[0] || null,
    stock_quantity: Number(product.stock_quantity || 0),
    physical_stock_quantity: Number(product.physical_stock_quantity || 0),
    reserved_stock_quantity: Number(product.reserved_stock_quantity || 0),
    average_cost: Number(product.average_cost || product.default_cost || 0)
  };
}

export function workspaceFromOfflineBundle(bundle, localSales = []) {
  const catalog = bundle?.catalog || {};
  const consumed = new Map();
  for (const sale of localSales.filter((row) => ["pending", "syncing", "conflict", "synced"].includes(row.status))) {
    for (const item of sale.payload?.items || []) {
      const product = (catalog.products || []).find((row) => row.id === item.product_id);
      const unit = (product?.product_units || []).find((row) => row.id === item.product_unit_id);
      const base = Number(item.quantity || 0) * Number(unit?.conversion_factor || 1);
      consumed.set(item.product_id, Number(consumed.get(item.product_id) || 0) + base);
    }
  }
  return {
    products: (catalog.products || []).map(normalizeSnapshotProduct).map((product) => ({
      ...product,
      stock_quantity: Math.max(0, Number(product.stock_quantity || 0) - Number(consumed.get(product.id) || 0))
    })),
    categories: catalog.categories || [],
    customers: catalog.customers || [],
    parkedSales: [],
    recentSales: []
  };
}

function localReceiptNumber(profile, sequence) {
  const branch = String(profile?.branches?.code || profile?.branch_id || "BR").replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  const date = new Date();
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("");
  return `OFF-${branch}-${day}-${String(sequence).padStart(4, "0")}`;
}

async function nextLocalSequence(profileKey) {
  const sales = await listOfflineSalesByProfileKey(profileKey);
  const today = new Date().toISOString().slice(0, 10);
  return sales.filter((sale) => String(sale.offline_created_at || "").startsWith(today)).length + 1;
}

export async function queueOfflineSale(profile, bundle, values) {
  if (!bundle?.session?.id) throw new Error("Prepare Offline Checkout before accepting an offline payment.");
  if (offlineBundleExpired(bundle)) throw new Error("The offline checkout bundle has expired. Reconnect and prepare it again.");

  const profileKey = offlineProfileKey(profile);

  const stored = await listOfflineSalesByProfileKey(profileKey);
  const committed = stored.filter((sale) => ["pending", "syncing", "conflict", "synced"].includes(sale.status));
  const consumed = new Map();
  for (const sale of committed) {
    for (const item of sale.payload?.items || []) {
      const product = (bundle.catalog?.products || []).find((row) => row.id === item.product_id);
      const unit = (product?.product_units || []).find((row) => row.id === item.product_unit_id);
      const base = Number(item.quantity || 0) * Number(unit?.conversion_factor || 1);
      consumed.set(item.product_id, Number(consumed.get(item.product_id) || 0) + base);
    }
  }
  for (const item of values.items || []) {
    const product = (bundle.catalog?.products || []).find((row) => row.id === item.product_id);
    const unit = (product?.product_units || []).find((row) => row.id === item.product_unit_id);
    if (!product || !unit) throw new Error("A cart item is not available in the prepared offline snapshot.");
    const requested = Number(item.quantity || 0) * Number(unit.conversion_factor || 1);
    const already = Number(consumed.get(item.product_id) || 0);
    const available = Number(product.stock_quantity || 0);
    if (product.track_stock && !product.allow_negative_stock && already + requested > available + 0.0005) {
      throw new Error(`${product.name} has only ${Math.max(0, available - already)} available for this offline device.`);
    }
    consumed.set(item.product_id, already + requested);
  }

  const offlineSaleId = createOfflineId();
  const sequence = await nextLocalSequence(profileKey);
  const createdAt = new Date().toISOString();
  const localNumber = localReceiptNumber(profile, sequence);

  const record = {
    offline_sale_id: offlineSaleId,
    profile_key: profileKey,
    organization_id: profile.organization_id,
    branch_id: profile.branch_id,
    user_id: profile.id,
    session_id: bundle.session.id,
    local_receipt_number: localNumber,
    offline_created_at: createdAt,
    status: "pending",
    attempts: 0,
    error_code: null,
    error_message: null,
    server_sale_id: null,
    invoice_number: null,
    synced_at: null,
    payload: {
      ...values,
      local_receipt_number: localNumber,
      offline_created_at: createdAt,
      discount_type: "none",
      discount_value: 0,
      coupon_code: null
    }
  };

  await withStore(SALE_STORE, "readwrite", async (store) => {
    await requestPromise(store.add(record));
  });
  emit();
  return record;
}

async function listOfflineSalesByProfileKey(profileKey) {
  return withStore(SALE_STORE, "readonly", async (store) => {
    const all = await requestPromise(store.getAll());
    return (all || [])
      .filter((sale) => sale.profile_key === profileKey)
      .sort((a, b) => String(b.offline_created_at).localeCompare(String(a.offline_created_at)));
  });
}

export async function listOfflineSales(profile) {
  const profileKey = offlineProfileKey(profile);
  if (!profileKey) return [];
  return listOfflineSalesByProfileKey(profileKey);
}

export async function updateOfflineSale(offlineSaleId, patch) {
  await withStore(SALE_STORE, "readwrite", async (store) => {
    const current = await requestPromise(store.get(offlineSaleId));
    if (!current) throw new Error("Offline sale was not found on this device.");
    await requestPromise(store.put({ ...current, ...patch }));
  });
  emit();
}

export async function deleteOfflineSale(offlineSaleId) {
  await withStore(SALE_STORE, "readwrite", async (store) => {
    await requestPromise(store.delete(offlineSaleId));
  });
  emit();
}

function isRetryableSyncError(error) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const message = String(error?.message || error || "").toLowerCase();
  return ["failed to fetch", "network", "timeout", "timed out", "connection", "offline"]
    .some((term) => message.includes(term));
}

export async function synchronizeOfflineSale(supabase, sale) {
  await updateOfflineSale(sale.offline_sale_id, {
    status: "syncing",
    attempts: Number(sale.attempts || 0) + 1,
    last_attempt_at: new Date().toISOString()
  });

  const { data, error } = await supabase.rpc("sync_offline_sale", {
    p_session_id: sale.session_id,
    p_offline_sale_id: sale.offline_sale_id,
    p_payload: sale.payload
  });

  if (error) {
    const retryable = isRetryableSyncError(error);
    await updateOfflineSale(sale.offline_sale_id, {
      status: retryable ? "pending" : "conflict",
      error_code: error.code || (retryable ? "NETWORK_RETRY" : "RPC_CONFLICT"),
      error_message: error.message
    });
    throw error;
  }

  const synced = Boolean(data?.ok && data?.status === "synced");
  await updateOfflineSale(sale.offline_sale_id, {
    status: synced ? "synced" : "conflict",
    error_code: data?.error_code || null,
    error_message: data?.error_message || null,
    server_sale_id: data?.sale_id || null,
    invoice_number: data?.invoice_number || null,
    synced_at: synced ? new Date().toISOString() : null
  });

  return data;
}

export async function synchronizeOfflineQueue(supabase, profile) {
  if (!navigator.onLine) return { synced: 0, conflicts: 0, remaining: 0 };
  const sales = await listOfflineSales(profile);
  const candidates = sales.filter((sale) => ["pending", "conflict"].includes(sale.status));
  let synced = 0;
  let conflicts = 0;

  for (const sale of candidates) {
    try {
      const result = await synchronizeOfflineSale(supabase, sale);
      if (result?.ok) synced += 1;
      else conflicts += 1;
    } catch {
      conflicts += 1;
    }
  }

  const after = await listOfflineSales(profile);
  return {
    synced,
    conflicts,
    remaining: after.filter((sale) => ["pending", "syncing", "conflict"].includes(sale.status)).length
  };
}

export function subscribeOfflineQueue(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveOfflineAuthSnapshot(session, profile, preferences, shop, access) {
  if (!session?.user?.id || !profile?.id) return;
  try {
    localStorage.setItem(
      `${AUTH_KEY_PREFIX}${session.user.id}`,
      JSON.stringify({
        version: 1,
        saved_at: new Date().toISOString(),
        user_id: session.user.id,
        profile,
        preferences,
        shop,
        access
      })
    );
  } catch {
    // Offline auth caching is best-effort and never blocks online login.
  }
}

export function loadOfflineAuthSnapshot(userId) {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(`${AUTH_KEY_PREFIX}${userId}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function clearOfflineAuthSnapshot(userId) {
  if (!userId) return;
  try {
    localStorage.removeItem(`${AUTH_KEY_PREFIX}${userId}`);
  } catch {
    // Nothing else is required.
  }
}
