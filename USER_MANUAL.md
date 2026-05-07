# VEG CRAFT - User Manual

This manual explains how to use the VEG CRAFT system end-to-end:

- Customer app (QR ordering)
- Admin app (orders, bills, tables/QR, settings)
- Firebase-backed live updates

## 1) Live URLs

- Customer app: `https://veg-cafe.web.app`
- Admin app: `https://veg-cafe.web.app/admin`
- Firebase console: `https://console.firebase.google.com/project/veg-cafe/overview`

## 2) System Overview

VEG CRAFT uses Firebase for real-time operations:

- Firestore collections: `menus`, `orders`, `tables`, `tableLocks`, `settlements`, `serviceRequests`
- Storage path for dish images: `menu_images/{menuId}/...`
- Hosting serves both customer and admin UI

## 3) Customer App Features

### 3.1 Entry and Table Lock

- Customers scan a table QR to open the app with `?table=<number>`
- Table is session-locked (`tableLocks`) to avoid multiple parties on same table
- If table is busy, customer sees a blocked popup and available table suggestions

### 3.2 Menu and Ordering

- Menu groups dishes by category
- Item card supports image, name, description, and price
- If dish has both regular and large price, customer sees a portion picker:
  - Small / Regular
  - Large
- Cart supports quantity increase/decrease
- "View order" opens review popup before placing order

### 3.3 Bill Visibility

- Customer sees "Your table bill (unpaid)" only when amount > 0
- Bill button is hidden automatically when total becomes 0
- Orders tab shows live order history and table bill summary

### 3.4 Service Request / Call Staff

- Floating "Call staff" button sends request to `serviceRequests`
- Rate-limited to prevent rapid repeated taps

### 3.5 Session End After Bill Settlement

- When admin settles table bill and lock is released, customer session is cleared
- Customer receives centered thank-you popup:
  - "Thank you for visiting Veg Craft. Please visit again!"

## 4) Admin App Features

## 4.1 Login and Main Navigation

- Admin login screen with local auth state
- Tabs:
  - Orders
  - Bills
  - Settings

### 4.2 Orders

- Views: Active, Past, Both, Rejected
- Kitchen status actions (prepare/ready/completed based flow)
- Edit order via pencil/edit action
- Rename "Reject" to "Cancel" in active flow
- Delete action removed from active order flow
- Manual order creation with table lock claim support
- History panel with day-based filtering

### 4.3 Bills

Bills tab has two sub-tabs:

- Pending
  - Table-wise pending unpaid totals
  - "Bill paid" action per table
  - Pending-order safety popup blocks settlement if kitchen statuses are not terminal

- Received
  - Default: today only
  - Optional history mode:
    - From/To date filter
    - Daily settlement list
    - Click a day to view table-wise settlement rows

### 4.4 Service Requests

- Admin receives real-time service requests from customers
- Continuous beep sound plays while unhandled requests exist
- "Mark handled" stops alert when queue is cleared

### 4.5 Tables and QR

- Table management with fixed/default table set support
- QR generation per table
- Download and print:
  - Single QR
  - All QRs
- Download/print card includes friendly message and brand text

### 4.6 Menu Management (Settings -> Menu/Food List)

- Add Product modal (centered)
  - Mandatory fields marked with `*`
  - Required validation with red input border
  - Image upload required
- Category input supports:
  - choose existing category
  - add new category
- Category normalization avoids duplicate headings like `PIZZA` vs `Pizza`
- Edit Product modal (centered)
  - Upload/change image
  - Success toast after image upload
  - Clear error on upload failure with storage guidance

### 4.7 Settings / Utility Operations

- Free table lock flow with safety checks
- Clear all orders utility
- Settings consolidation for less-frequent admin actions

## 5) Data and Sync Behavior

- Customer and admin apps subscribe to Firestore in real time
- Admin edits to orders/menu reflect on customer side
- Settlements recorded in `settlements` collection
- Billing state and table lock release are connected

## 6) Deployment Notes

- Hosting URL serves customer at root and admin at `/admin`
- Rules deployed:
  - `firestore.rules`
  - `storage.rules`

For deployment and re-deployment commands, see:

- `REDEPLOYMENT_STEPS.txt`
