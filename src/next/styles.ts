/**
 * The entire visual layer, inlined. The package must render identically inside a
 * host using Tailwind, plain CSS, or nothing at all, so it imports no stylesheet
 * and inherits nothing. Every selector below is anchored on an `ops-`-prefixed
 * class — there is no bare element, `body`, or `*` rule — so nothing here can
 * ever match a host element outside this package's own markup, even though not
 * every rule is literally written as a descendant of `.ops-root`.
 *
 * React escapes the text child of a `<style>` element, so a selector containing
 * `>` or `&` would silently turn into an HTML entity and stop matching, with no
 * error. That is why every rule here uses plain class selectors and, where
 * needed, a space (descendant combinator) — never `>` or `&`.
 */
export const OPS_STYLES = `
.ops-root { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; color: #16202c; background: #f6f7f9;
  min-height: 100vh; margin: 0; padding: 24px; }
.ops-root * { box-sizing: border-box; }
.ops-shell { max-width: 1040px; margin: 0 auto; }
.ops-nav { display: flex; gap: 16px; align-items: center; margin-bottom: 20px;
  padding-bottom: 12px; border-bottom: 1px solid #dfe3e8; }
.ops-nav a { color: #33506e; text-decoration: none; font-weight: 600; }
.ops-nav a[aria-current] { color: #0b1622; text-decoration: underline; }
.ops-nav .ops-spacer { margin-left: auto; }
.ops-card { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.ops-card h2 { margin: 0 0 12px; font-size: 15px; }
table.ops-table { width: 100%; border-collapse: collapse; }
.ops-table th, .ops-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eceff2; }
.ops-table th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7784; }
.ops-tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.ops-tag.warn { background: #fdf0d5; color: #6b4b06; }
.ops-tag.bad { background: #fbe1e1; color: #7d1d1d; }
.ops-tag.good { background: #e2f1e5; color: #1d5b2c; }
.ops-tag.neutral { background: #e8eaed; color: #3c4450; }
.ops-root input, .ops-root select, .ops-root button { font: inherit; padding: 6px 10px;
  border: 1px solid #c8ced6; border-radius: 6px; background: #fff; }
.ops-root button { background: #1f3a5f; color: #fff; border-color: #1f3a5f; cursor: pointer; font-weight: 600; }
.ops-root button.ops-danger { background: #8c2020; border-color: #8c2020; }
form.ops-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0; }
.ops-reveal { background: #0e1726; color: #d9f2e3; padding: 12px 14px; border-radius: 8px;
  font-family: ui-monospace, monospace; word-break: break-all; }
.ops-note { color: #6b7784; font-size: 13px; }
.ops-error { background: #fbe1e1; color: #7d1d1d; padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; }
.ops-pre { background: #0e1726; color: #d9f2e3; padding: 12px 14px; border-radius: 8px;
  font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word;
  overflow-x: auto; margin: 8px 0 0; }
`;
