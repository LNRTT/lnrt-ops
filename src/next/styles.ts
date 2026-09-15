/** Scoped, self-contained styles: host Tailwind/preflight must not change Ops. */
export const OPS_STYLES = `
.ops-root { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #16202c; background: #f6f7f9;
  min-height: 100vh; margin: 0; padding: 24px; color-scheme: light; overflow-wrap: anywhere; }
.ops-root * { box-sizing: border-box; }
.ops-shell { max-width: 1040px; min-width: 0; margin: 0 auto; }
.ops-root h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.3; font-weight: 700; }
.ops-root p { margin: 8px 0 12px; }
.ops-root a { color: #254e7b; text-decoration: underline; text-underline-offset: 3px; }
.ops-root a:focus-visible, .ops-root button:focus-visible, .ops-root input:focus-visible,
.ops-root select:focus-visible, .ops-root textarea:focus-visible, .ops-root summary:focus-visible {
  outline: 3px solid #548cc5; outline-offset: 3px; }
.ops-topbar { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.ops-topbar .ops-brand { color: #16202c; font-size: 20px; font-weight: 700; text-decoration: none; }
.ops-nav { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin-bottom: 24px;
  padding: 4px; border: 1px solid #dfe3e8; border-radius: 10px; background: #edf0f4; }
.ops-nav a { display: flex; justify-content: center; align-items: center; min-height: 44px; padding: 8px 4px;
  color: #33506e; text-decoration: none; font-weight: 600; border-radius: 6px; }
.ops-nav a[aria-current] { color: #0b1622; background: #fff; box-shadow: 0 1px 3px #16202c20; }
.ops-page-heading { margin-bottom: 20px; }
.ops-card { min-width: 0; background: #fff; border: 1px solid #dfe3e8; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
.ops-card h2 { margin: 0 0 12px; font-size: 16px; line-height: 1.4; font-weight: 700; }
.ops-card summary { cursor: pointer; font-weight: 600; min-height: 28px; }
.ops-card[open] summary { margin-bottom: 16px; }
.ops-delete summary { color: #8c2020; }
.ops-back a { display: inline-flex; min-height: 44px; align-items: center; }
.ops-user-email { font-size: 16px; }
table.ops-table { width: 100%; table-layout: fixed; border-collapse: collapse; margin-top: 16px; }
.ops-table th, .ops-table td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #eceff2; vertical-align: top; overflow-wrap: anywhere; }
.ops-table th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #526170; font-weight: 600; }
.ops-table td a { font-weight: 600; }
.ops-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.ops-tag { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.ops-tag.warn { background: #fdf0d5; color: #6b4b06; }
.ops-tag.bad { background: #fbe1e1; color: #7d1d1d; }
.ops-tag.good { background: #e2f1e5; color: #1d5b2c; }
.ops-tag.neutral { background: #e8eaed; color: #3c4450; }
.ops-root input, .ops-root select, .ops-root button, .ops-root textarea { font: inherit; padding: 10px 12px;
  color: #16202c; min-height: 44px; min-width: 0; max-width: 100%; border: 1px solid #b9c3cf; border-radius: 6px; background: #fff; }
.ops-root input[type=hidden] { display: none; }
.ops-root input[type=checkbox] { width: 18px; height: 18px; min-height: 18px; flex: 0 0 18px; padding: 0; margin: 0; accent-color: #1f3a5f; }
.ops-root button, .ops-root .ops-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  background: #1f3a5f; color: #fff; border: 1px solid #1f3a5f; cursor: pointer; font-weight: 600; text-decoration: none; }
.ops-root .ops-btn { min-height: 44px; padding: 10px 12px; border-radius: 6px; }
.ops-root button:disabled { opacity: .65; cursor: wait; }
.ops-root button.ops-secondary { background: #fff; color: #1f3a5f; border-color: #b9c3cf; }
.ops-root button.ops-danger { background: #8c2020; border-color: #8c2020; }
form.ops-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
form.ops-action-form, form.ops-filter-form { align-items: flex-end; }
.ops-field { display: flex; min-width: 0; flex: 1 1 180px; flex-direction: column; gap: 6px; font-weight: 600; }
.ops-field input, .ops-field select, .ops-field textarea { width: 100%; font-weight: 400; }
.ops-checkbox { display: inline-flex; gap: 8px; align-items: center; min-height: 44px; cursor: pointer; }
.ops-clear { display: inline-flex; min-height: 44px; align-items: center; }
.ops-root .ops-reveal { display: block; width: 100%; background: #0e1726; color: #d9f2e3; padding: 12px 14px;
  border-radius: 8px; font-family: ui-monospace, monospace; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 360px; resize: vertical; }
.ops-copy { min-width: 0; }
.ops-copy button { margin-top: 12px; }
.ops-copy .ops-note { min-height: 20px; }
.ops-note { color: #526170; font-size: 13px; }
.ops-error { background: #fbe1e1; color: #7d1d1d; padding: 12px; border-radius: 6px; margin-bottom: 12px; }
.ops-success { background: #e2f1e5; color: #1d5b2c; padding: 12px; border-radius: 6px; font-weight: 600; }
.ops-pre { max-width: 100%; background: #0e1726; color: #d9f2e3; padding: 12px 14px; border-radius: 8px;
  font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; overflow-x: auto; margin: 8px 0 0; }
@media (max-width: 700px) {
  .ops-root { padding: 12px; }
  .ops-card { padding: 16px; }
  .ops-card summary { min-height: 44px; padding: 10px 0; }
  .ops-root input, .ops-root select, .ops-root textarea { font-size: 16px; }
  .ops-nav { margin-bottom: 20px; }
  .ops-root h1 { font-size: 20px; }
  form.ops-action-form, form.ops-filter-form { flex-direction: column; align-items: stretch; }
  .ops-action-form .ops-field, .ops-filter-form .ops-field { flex: 0 1 auto; }
  .ops-copy button, .ops-row button { width: 100%; }
  table.ops-mobile-table, .ops-mobile-table tbody { display: block; }
  .ops-mobile-table thead { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  .ops-mobile-table tr { display: block; border: 1px solid #dfe3e8; border-radius: 8px; padding: 8px 10px; margin-bottom: 12px; }
  .ops-mobile-table td { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; padding: 6px 0; border: 0; }
  .ops-mobile-table td::before { content: attr(data-label); color: #526170; font-size: 12px; font-weight: 600; }
}
@media (min-width: 701px) and (max-width: 1000px) {
  table.ops-errors-table, .ops-errors-table tbody { display: block; }
  .ops-errors-table thead { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow: hidden; }
  .ops-errors-table tr { display: block; border: 1px solid #dfe3e8; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .ops-errors-table td { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; padding: 4px 0; border: 0; }
  .ops-errors-table td::before { content: attr(data-label); color: #526170; font-size: 12px; font-weight: 600; }
}
`;
