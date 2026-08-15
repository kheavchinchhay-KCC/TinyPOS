# Tiny POS NEW — Step 4: Categories, Products, Stock and Cloudinary

This package is only for the NEW Tiny POS GitHub repository and NEW Netlify site. The old POS must remain untouched.

## Install order

### A. Run the Supabase migration first

1. Open the new Supabase project.
2. Open SQL Editor → New query.
3. Open `database/02_products_categories.sql`.
4. Paste the entire file and click Run once.
5. Expected result: `Success. No rows returned`.

This adds secure product creation/update functions, automatic product codes beginning at `P000001`, opening-stock records, stock movements and audit logs.

### B. Create a separate Cloudinary configuration

Use a new Cloudinary product environment/account for this new POS. Copy:

- Cloud name
- API key
- API secret

### C. Add three Netlify environment variables

Keep the two existing Supabase variables and add:

- `CLOUDINARY_CLOUD_NAME` — not secret
- `CLOUDINARY_API_KEY` — not secret
- `CLOUDINARY_API_SECRET` — check **Contains secret values**

Make sure the variables include the Functions scope. Redeploy after saving.

### D. Replace files only in the NEW GitHub repository

1. Extract this ZIP.
2. Open the GitHub repository connected to the new Netlify test site.
3. Replace the Step 3 project files with every file from this package.
4. Keep the files at repository root. `package.json`, `netlify.toml`, `src`, `database`, and `netlify` must be visible at the top level.
5. Commit the upload and wait for Netlify to deploy.

## Test checklist

1. Log in as the owner.
2. Open Products.
3. Open Categories and create a category.
4. Add a product without entering a product code.
5. Confirm the system creates `P000001`.
6. Add barcode, selling price, cost, opening stock and photo.
7. Confirm the photo appears in the product list.
8. Edit the product and refresh the page.
9. Confirm Dashboard product and low-stock counts update.

## Important

- Do not enter or expose `CLOUDINARY_API_SECRET` in browser files.
- The browser uploads directly to Cloudinary only after a Netlify Function creates a short-lived signed request.
- Only owner, admin and manager roles can create/edit products or photos.
- Product stock is not edited directly from the product form after creation. A secure stock-adjustment module will be added next.

## Next step

Step 5 adds inventory adjustment, stock count, purchase receiving and stock movement history.
