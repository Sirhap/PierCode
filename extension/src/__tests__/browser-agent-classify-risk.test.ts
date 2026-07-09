import { describe, expect, it } from 'vitest';
import { classifyRisk } from '../background/browser-agent';
import { APPROVAL_TOOLS } from '../background/browser/gates';

// audit #6: the sidebar browser-agent route gates solely on classifyRisk (it sets
// skipApproval, bypassing the server's APPROVAL_TOOLS gate). Any APPROVAL_TOOLS
// member that classifyRisk left at `default: safe` ran UNPROMPTED. These were the
// drifted tools; they must now classify highRisk.
const ALWAYS_HIGH_RISK = [
  'browser_hover',        // was missing (audit #6)
  'browser_use_tab',      // was missing (audit #6)
  'browser_finalize_tabs',// was missing (audit #6)
  'browser_zoom',         // was missing (audit #6)
  // already-gated dangerous tools — pinned so a future edit can't silently drop them
  'browser_upload', 'browser_evaluate', 'browser_clipboard', 'browser_handle_dialog',
  'browser_cookies', 'browser_set_cookie', 'browser_form_input', 'browser_select',
  'browser_drag',
  'browser_intercept', 'browser_reset',   // testing state/network mutators
];

describe('classifyRisk vs APPROVAL_TOOLS (audit #6)', () => {
  for (const name of ALWAYS_HIGH_RISK) {
    it(`${name} is high risk so the sidebar route prompts`, () => {
      const r = classifyRisk(name, {});
      expect(r.highRisk, `${name} must be gated`).toBe(true);
    });
  }

  it('every unconditionally-dangerous APPROVAL_TOOLS member is covered above', () => {
    // The only APPROVAL_TOOLS entries NOT in ALWAYS_HIGH_RISK are the ones whose
    // risk is conditional on their target (click/type — safe for benign targets
    // by design). If a new always-dangerous tool is added to APPROVAL_TOOLS, it
    // should be added to ALWAYS_HIGH_RISK + classifyRisk too.
    const conditional = new Set(['browser_click', 'browser_type', 'browser_press_key']);
    const covered = new Set(ALWAYS_HIGH_RISK);
    const uncovered = [...APPROVAL_TOOLS].filter(t => !covered.has(t) && !conditional.has(t));
    expect(uncovered, `unhandled APPROVAL_TOOLS: ${uncovered.join(', ')}`).toEqual([]);
  });

  // audit #19: a duplicate `case 'browser_upload'` used to sit unreachable after
  // the first; removing it must not change that browser_upload is still gated.
  it('browser_upload remains gated after duplicate-case removal (audit #19)', () => {
    expect(classifyRisk('browser_upload', {}).highRisk).toBe(true);
  });
});

describe('classifyRisk browser_test (recursive, mirrors browser_batch)', () => {
  it('safe when every step is safe', () => {
    const r = classifyRisk('browser_test', {
      steps: [
        { name: 'browser_navigate', input: { url: 'https://x.com/a' } },
        { name: 'browser_assert', input: { kind: 'url', expect: 'x.com' } },
        { name: 'browser_wait_stable', input: {} },
      ],
    }, undefined, 'https://x.com');
    expect(r.highRisk).toBe(false);
  });

  it('high risk when any step is high risk (submit)', () => {
    const r = classifyRisk('browser_test', {
      steps: [
        { name: 'browser_click', input: { selector: '#a' } },
        { name: 'browser_type', input: { text: 'q', submit: true } },
      ],
    });
    expect(r.highRisk).toBe(true);
    expect(r.reason).toMatch(/submits/);
  });

  it('accepts the {tool,args} alias shape for steps', () => {
    const r = classifyRisk('browser_test', {
      steps: [{ tool: 'browser_evaluate', args: { expression: '1' } }],
    });
    expect(r.highRisk).toBe(true);
  });
});
