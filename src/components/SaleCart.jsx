import { useEffect, useMemo, useState } from "react";
import {
  BadgeDollarSign,
  Check,
  CirclePause,
  Minus,
  Plus,
  TicketPercent,
  FileText,
  UserPlus,
  Wallet,
  X
} from "lucide-react";
import { money, stockNumber } from "../lib/catalog";

function lineId(item, index = 0) {
  return item.cart_line_id || `${item.id}:${item.selected_unit_id || "base"}:${index}`;
}

function getItemUnits(item) {
  const rawUnits = [...(item.product_units || item.units || [])].filter(
    (u) => u.is_active !== false
  );

  const productName = String(item.name || "").trim().toLowerCase();
  const productNameKm = String(item.name_km || "").trim().toLowerCase();
  const rawBaseUnitName = String(item.unit_name || "pcs").trim();
  const safeBaseUnitName = [rawBaseUnitName, "pcs"].find((value) => {
    const lower = String(value).trim().toLowerCase();
    return lower && lower !== productName && lower !== productNameKm;
  }) || "pcs";

  const hasBase = rawUnits.some((u) => u.is_base);
  let units = rawUnits.map((u) => ({ ...u }));

  if (!hasBase) {
    const existing = units.find(
      (u) => String(u.name || "").trim().toLowerCase() === rawBaseUnitName.toLowerCase()
    );
    if (existing) {
      existing.is_base = true;
    } else {
      units.unshift({
        id: `base-${item.id}`,
        name: safeBaseUnitName,
        short_name: safeBaseUnitName,
        conversion_factor: 1,
        selling_price: Number(item.selling_price || 0),
        is_base: true,
        is_active: true
      });
    }
  }

  const normalized = units
    .map((u) => {
      const rawName = String(u.name || "").trim();
      const rawShortName = String(u.short_name || "").trim();
      const nameLower = rawName.toLowerCase();
      const shortLower = rawShortName.toLowerCase();
      const looksLikeProductName =
        nameLower === productName
        || nameLower === productNameKm
        || shortLower === productName
        || shortLower === productNameKm;
      const displayName = looksLikeProductName
        ? (rawShortName && shortLower !== productName && shortLower !== productNameKm
          ? rawShortName
          : (u.is_base ? safeBaseUnitName : rawBaseUnitName || "pcs"))
        : (rawShortName || rawName || (u.is_base ? safeBaseUnitName : "pcs"));

      return {
        ...u,
        id: String(u.id || `unit-${displayName}`),
        name: displayName,
        short_name: displayName,
        conversion_factor: Number(u.conversion_factor || 1),
        selling_price: Number(u.selling_price ?? item.selling_price ?? 0)
      };
    })
    .filter((u, index, list) =>
      list.findIndex((candidate) => candidate.id === u.id) === index
    );

  return normalized.sort(
    (a, b) =>
      Number(b.is_base) - Number(a.is_base)
      || Number(a.sort_order || 0) - Number(b.sort_order || 0)
  );
}

function CartLineList({
  cart,
  onQuantityChange,
  onUnitChange,
  onRemove,
  fulfillmentLocked = false,
  compact = false,
  unitNameOnly = false
}) {
  return (
    <div className={`sale-cart-lines ${compact ? "compact-layout" : ""}`}>
      {cart.length === 0 ? (
        <div className="cart-empty">
          <Wallet size={42} />
          <strong>No products in this bill</strong>
          <span>Tap a product or scan a barcode.</span>
        </div>
      ) : (
        cart.map((item, index) => {
          const units = getItemUnits(item);
          const factor = Number(item.selected_unit_factor || 1);
          const selectedPrice = Number(
            item.selected_unit_price ?? item.selling_price ?? 0
          );
          const standardPrice = Number(
            item.standard_unit_price ?? selectedPrice
          );
          const availableSelectedUnits = factor > 0
            ? Number(item.stock_quantity || 0) / factor
            : Number(item.stock_quantity || 0);
          const selectedUnit = units.find((unit) => String(unit.id) === String(item.selected_unit_id)) || units[0];
          const selectedUnitDisplay = selectedUnit?.short_name || selectedUnit?.name || item.unit_name || "pcs";
          const currentLineId = lineId(item, index);
          const lineTotal = selectedPrice * Number(item.quantity);

          return (
            <article
              className={`sale-cart-line ${compact ? "compact" : ""}`}
              key={currentLineId}
            >
              <div className="cart-line-number">{index + 1}</div>

              <div className="cart-line-text">
                <strong className="cart-line-name" title={item.name}>
                  {item.name}
                </strong>

                <span className="cart-line-math">
                  {standardPrice !== selectedPrice && (
                    <del>{money(standardPrice, item.currency)}</del>
                  )}
                  {money(selectedPrice, item.currency)} × {stockNumber(item.quantity)} = {" "}
                  <b>{money(lineTotal, item.currency)}</b>
                </span>
              </div>

              <span className="cart-line-mobile-summary no-translate" data-i18n-skip>
                {index + 1} {item.name} {money(selectedPrice, item.currency)} × {stockNumber(item.quantity)} = {money(lineTotal, item.currency)}
              </span>

              <div className="cart-line-unit-control">
                {units.length > 1 ? (
                  <select
                    value={item.selected_unit_id || units[0]?.id || ""}
                    onChange={(event) => onUnitChange(currentLineId, event.target.value)}
                    aria-label={`${item.name} selling unit`}
                    disabled={fulfillmentLocked}
                  >
                    {units.map((unit) => (
                      <option value={unit.id} key={unit.id}>
                        {unitNameOnly
                          ? (unit.short_name || unit.name)
                          : `${unit.name} · ${money(unit.selling_price, item.currency)}`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="single-unit-label">
                    {unitNameOnly
                      ? selectedUnitDisplay
                      : selectedUnitDisplay}
                  </span>
                )}
              </div>

              <div className="cart-quantity-controls">
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onQuantityChange(currentLineId, Number(item.quantity) - 1)}
                  disabled={fulfillmentLocked}
                  aria-label={`Reduce ${item.name}`}
                >
                  <Minus size={17} />
                </button>
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={item.quantity}
                  onChange={(event) => onQuantityChange(currentLineId, event.target.value)}
                  disabled={fulfillmentLocked}
                  aria-label={`${item.name} quantity`}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onQuantityChange(currentLineId, Number(item.quantity) + 1)}
                  disabled={fulfillmentLocked}
                  aria-label={`Add ${item.name}`}
                >
                  <Plus size={17} />
                </button>
                <button
                  type="button"
                  className="icon-button danger-icon"
                  onClick={() => onRemove(currentLineId)}
                  disabled={fulfillmentLocked}
                  aria-label={`Remove ${item.name}`}
                >
                  <X size={17} />
                </button>
              </div>

              <div className="cart-line-stock">
                <small>
                  Available: {item.track_stock
                    ? `${stockNumber(availableSelectedUnits)} ${selectedUnitDisplay}`
                    : "Not tracked"}
                </small>
                {factor !== 1 && (
                  <small>
                    1 {item.selected_unit_name || item.unit_name} = {stockNumber(factor)} {item.unit_name}
                  </small>
                )}
              </div>
            </article>
          );
        })
      )}
    </div>
  );
}

function CustomerPicker({
  customers,
  customerId,
  onCustomerChange,
  onAddCustomer,
  fulfillmentLocked = false,
  online = true
}) {
  const selectedCustomer = useMemo(
    () => customers.find((customer) => String(customer.id) === String(customerId)) || null,
    [customers, customerId]
  );
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);

  useEffect(() => {
    if (selectedCustomer) {
      setCustomerSearch(
        `${selectedCustomer.name}${selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ""}`
      );
    } else if (!customerPickerOpen) {
      setCustomerSearch("");
    }
  }, [selectedCustomer, customerPickerOpen]);

  const customerMatches = useMemo(() => {
    const needle = customerSearch.trim().toLowerCase();
    if (!needle) return customers.slice(0, 12);
    return customers.filter((customer) =>
      [customer.name, customer.phone, customer.email, customer.customer_code]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle)
    ).slice(0, 12);
  }, [customers, customerSearch]);

  function selectCustomer(customer) {
    onCustomerChange(customer?.id || "");
    setCustomerSearch(customer
      ? `${customer.name}${customer.phone ? ` · ${customer.phone}` : ""}`
      : "");
    setCustomerPickerOpen(false);
  }

  return (
    <div className="customer-select-row">
      <label
        className="customer-search-picker"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setCustomerPickerOpen(false);
            const trimmed = customerSearch.trim().toLowerCase();
            if (!trimmed) {
              selectCustomer(null);
            } else {
              const exactMatch = customers.find(c =>
                c.name.toLowerCase() === trimmed || c.phone === trimmed
              );
              if (exactMatch) {
                selectCustomer(exactMatch);
              } else if (customerMatches.length === 1) {
                selectCustomer(customerMatches[0]);
              } else if (selectedCustomer) {
                setCustomerSearch(
                  `${selectedCustomer.name}${selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ""}`
                );
              }
            }
          }
        }}
      >
        <span>Customer</span>
        <input
          value={customerSearch}
          onFocus={() => setCustomerPickerOpen(true)}
          onChange={(event) => {
            const value = event.target.value;
            setCustomerSearch(value);
            setCustomerPickerOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setCustomerPickerOpen(false);
            if (event.key === "Enter" && customerMatches[0]) {
              event.preventDefault();
              selectCustomer(customerMatches[0]);
            }
          }}
          disabled={fulfillmentLocked}
          placeholder="Walk-in or type customer name / phone"
          autoComplete="off"
        />
        {customerPickerOpen && !fulfillmentLocked && (
          <div className="customer-search-results">
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectCustomer(null)}>
              <strong>Walk-in customer</strong><small>No customer account</small>
            </button>
            {customerMatches.map((customer) => (
              <button type="button" key={customer.id} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCustomer(customer)}>
                <strong>{customer.name}</strong>
                <small>{[customer.phone, customer.email, customer.customer_code].filter(Boolean).join(" · ") || "Customer"}</small>
              </button>
            ))}
            {customerMatches.length === 0 && <span>No matching customer</span>}
          </div>
        )}
      </label>
      <button
        type="button"
        className="icon-button customer-add-button"
        onClick={onAddCustomer}
        disabled={!online || fulfillmentLocked}
        aria-label="Add customer"
        title="Add customer"
      >
        <UserPlus size={20} />
      </button>
    </div>
  );
}

function SaleCartHeader({
  cart,
  parkedCount,
  onOpenParked,
  onClear,
  online,
  fulfillmentLocked,
  title
}) {
  return (
    <div className="sale-cart-heading">
      <div>
        <p className="eyebrow">CURRENT BILL</p>
        <h2>{title || "New sale"}</h2>
      </div>

      <div className="sale-cart-heading-actions">
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={onOpenParked}
          disabled={!online || fulfillmentLocked}
        >
          <CirclePause size={17} />
          Parked ({parkedCount})
        </button>

        {cart.length > 0 && !fulfillmentLocked && (
          <button
            type="button"
            className="text-button danger-text"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function CreditAndPriceInfo({
  creditAccount,
  customerId,
  currency,
  priceListName
}) {
  return (
    <>
      {customerId && creditAccount && (
        <div className={`sale-customer-credit-strip ${creditAccount.is_on_hold ? "hold" : ""}`}>
          <span>
            Credit due {money(
              creditAccount.balance_due || 0,
              creditAccount.currency
            )}
          </span>
          <strong>
            Available {creditAccount.allow_unlimited_credit
              ? "Unlimited"
              : money(
                Math.max(
                  0,
                  Number(creditAccount.credit_limit || 0)
                  - Number(creditAccount.balance_due || 0)
                ),
                creditAccount.currency || currency
              )}
          </strong>
          {creditAccount.is_on_hold && <b>ON HOLD</b>}
        </div>
      )}

      {priceListName && (
        <div className="sale-price-list-strip">
          <BadgeDollarSign size={17} />
          <span>Price list</span>
          <strong>{priceListName}</strong>
        </div>
      )}
    </>
  );
}

function CheckoutControls({
  cart,
  discountType,
  discountValue,
  onDiscountTypeChange,
  onDiscountValueChange,
  couponCode,
  appliedCoupon,
  couponBusy,
  onCouponCodeChange,
  onApplyCoupon,
  onRemoveCoupon,
  notes,
  onNotesChange,
  totals,
  currency,
  exchangeRate = 4100,
  taxPercent,
  canDiscount = true,
  online = true,
  canSell = true,
  onPark,
  onSaveQuote,
  onPay,
  quoteEditable = true,
  activeQuoteNumber,
  fulfillmentLocked = false
}) {
  return (
    <>
      <div className="sale-cart-options">
        <div className="discount-row">
          <label>
            <span>Manual discount</span>
            <select
              value={discountType}
              onChange={(event) =>
                onDiscountTypeChange(event.target.value)
              }
              disabled={
                Boolean(appliedCoupon)
                || !canDiscount
                || fulfillmentLocked
              }
            >
              <option value="none">No discount</option>
              <option value="percent">Percentage</option>
              <option value="fixed">Fixed amount</option>
            </select>
          </label>
          <label>
            <span>
              {discountType === "percent" ? "Percent" : "Amount"}
            </span>
            <input
              type="number"
              min="0"
              max={discountType === "percent" ? "100" : undefined}
              step="0.01"
              value={discountValue}
              onChange={(event) =>
                onDiscountValueChange(event.target.value)
              }
              disabled={
                discountType === "none"
                || Boolean(appliedCoupon)
                || !canDiscount
                || fulfillmentLocked
              }
            />
          </label>
        </div>

        {!canDiscount && (
          <small className="permission-inline-note">
            Manual discounts are hidden for your account.
          </small>
        )}

        <div className="sale-coupon-block">
          <label>
            <span>Coupon code</span>
            <div className="sale-coupon-input-row">
              <TicketPercent size={18} />
              <input
                value={couponCode}
                onChange={(event) =>
                  onCouponCodeChange(event.target.value.toUpperCase())
                }
                placeholder="Enter coupon"
                disabled={couponBusy || Boolean(appliedCoupon) || fulfillmentLocked}
              />
              {appliedCoupon ? (
                <button
                  type="button"
                  className="icon-button"
                  onClick={onRemoveCoupon}
                  title="Remove coupon"
                >
                  <X size={18} />
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button coupon-apply-button"
                  onClick={onApplyCoupon}
                  disabled={
                    couponBusy
                    || cart.length === 0
                    || !couponCode.trim()
                    || !online
                    || fulfillmentLocked
                  }
                >
                  {couponBusy ? "Checking..." : "Apply"}
                </button>
              )}
            </div>
          </label>

          {appliedCoupon && (
            <div className="applied-coupon">
              <Check size={18} />
              <div>
                <strong>{appliedCoupon.code} · {appliedCoupon.name}</strong>
                <span>
                  Coupon discount {money(appliedCoupon.discount_amount, currency)}
                </span>
              </div>
            </div>
          )}
        </div>

        <label>
          <span>Remark</span>
          <input
            value={notes}
            onChange={(event) => onNotesChange(event.target.value)}
            disabled={fulfillmentLocked}
            placeholder="Optional sale note"
          />
        </label>
      </div>

      <div className="sale-total-block">
        <div>
          <span>Subtotal</span>
          <strong>{money(totals.subtotal, currency)}</strong>
        </div>
        <div>
          <span>{appliedCoupon ? "Coupon discount" : "Discount"}</span>
          <strong>-{money(totals.discountAmount, currency)}</strong>
        </div>
        {Number(taxPercent) > 0 && (
          <div>
            <span>Tax ({Number(taxPercent)}%)</span>
            <strong>{money(totals.taxAmount, currency)}</strong>
          </div>
        )}
        <div className="grand-total">
          <span>Total</span>
          <strong>{money(totals.total, currency)}</strong>
          <small>
            ≈ {money(
              currency === "USD"
                ? Number(totals.total || 0) * Number(exchangeRate || 4100)
                : Number(totals.total || 0) / Number(exchangeRate || 4100),
              currency === "USD" ? "KHR" : "USD"
            )}
          </small>
        </div>
      </div>

      {!online && (
        <div className="sale-cart-offline-note">
          This bill is saved locally. Reconnect to park or pay.
        </div>
      )}

      <div className="sale-cart-actions quote-enabled">
        <button
          type="button"
          className="secondary-button"
          onClick={onPark}
          disabled={
            !canSell
            || !online
            || cart.length === 0
            || Boolean(activeQuoteNumber)
            || fulfillmentLocked
          }
          title={
            activeQuoteNumber
              ? "A quotation cannot also be parked"
              : "Park sale"
          }
        >
          <CirclePause size={19} />
          Park sale
        </button>

        <button
          type="button"
          className="secondary-button quote-save-button"
          onClick={onSaveQuote}
          disabled={
            !canSell
            || !online
            || cart.length === 0
            || !quoteEditable
            || fulfillmentLocked
          }
          title={
            !quoteEditable
              ? "Accepted quotations cannot be edited"
              : activeQuoteNumber
                ? "Update quotation"
                : "Save quotation"
          }
        >
          <FileText size={19} />
          {activeQuoteNumber
            ? "Update Quote"
            : "Save Quote"}
        </button>

        <button
          type="button"
          className="primary-button pay-button"
          onClick={onPay}
          disabled={!canSell || !online || cart.length === 0}
        >
          <Wallet size={20} />
          Pay {money(totals.total, currency)}
        </button>
      </div>
    </>
  );
}

export function SaleCartLinesPanel({
  cart,
  onQuantityChange,
  onUnitChange,
  onRemove,
  onClear,
  onOpenParked,
  parkedCount = 0,
  online = true,
  fulfillmentLocked = false,
  activeParkLabel,
  activeQuoteNumber,
  fulfillmentLabel
}) {
  const title = fulfillmentLabel || activeParkLabel || activeQuoteNumber || "New sale";

  return (
    <section className="sale-cart-lines-panel panel">
      <SaleCartHeader
        cart={cart}
        parkedCount={parkedCount}
        onOpenParked={onOpenParked}
        onClear={onClear}
        online={online}
        fulfillmentLocked={fulfillmentLocked}
        title={title}
      />

      <div className="sale-cart-lines-count">
        <span>{cart.length} item{cart.length === 1 ? "" : "s"}</span>
      </div>

      <CartLineList
        cart={cart}
        onQuantityChange={onQuantityChange}
        onUnitChange={onUnitChange}
        onRemove={onRemove}
        fulfillmentLocked={fulfillmentLocked}
        unitNameOnly
      />
    </section>
  );
}

export function SaleCheckoutPanel(props) {
  return (
    <aside className="sale-checkout-panel panel">
      <div className="sale-checkout-heading">
        <div>
          <p className="eyebrow">CHECKOUT</p>
          <h2>Customer & payment</h2>
        </div>
        <strong>{props.cart.length} item{props.cart.length === 1 ? "" : "s"}</strong>
      </div>

      <CustomerPicker
        customers={props.customers}
        customerId={props.customerId}
        onCustomerChange={props.onCustomerChange}
        onAddCustomer={props.onAddCustomer}
        fulfillmentLocked={props.fulfillmentLocked}
        online={props.online}
      />

      <CreditAndPriceInfo
        creditAccount={props.creditAccount}
        customerId={props.customerId}
        currency={props.currency}
        priceListName={props.priceListName}
      />

      <CheckoutControls {...props} />
    </aside>
  );
}

export default function SaleCart(props) {
  const title = props.fulfillmentLabel || props.activeParkLabel || props.activeQuoteNumber || "New sale";
  return (
    <aside className="sale-cart panel">
      <SaleCartHeader
        cart={props.cart}
        parkedCount={props.parkedCount}
        onOpenParked={props.onOpenParked}
        onClear={props.onClear}
        online={props.online}
        fulfillmentLocked={props.fulfillmentLocked}
        title={title}
      />

      <CustomerPicker
        customers={props.customers}
        customerId={props.customerId}
        onCustomerChange={props.onCustomerChange}
        onAddCustomer={props.onAddCustomer}
        fulfillmentLocked={props.fulfillmentLocked}
        online={props.online}
      />

      <CreditAndPriceInfo
        creditAccount={props.creditAccount}
        customerId={props.customerId}
        currency={props.currency}
        priceListName={props.priceListName}
      />

      <CartLineList
        cart={props.cart}
        onQuantityChange={props.onQuantityChange}
        onUnitChange={props.onUnitChange}
        onRemove={props.onRemove}
        fulfillmentLocked={props.fulfillmentLocked}
        unitNameOnly
      />

      <CheckoutControls {...props} />
    </aside>
  );
}
