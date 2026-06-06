import { useEffect, useState } from 'react';
import {
  PROVIDERS,
  PROVIDERS_BY_ID,
  DEFAULT_PANES,
  addPane,
  removePane,
  movePane,
  paneSrc,
  type Pane,
} from './pane-manager';

const STORAGE_KEY = 'hubPanes';

// loadPanes / savePanes persist the pane layout so the Hub reopens with the same
// set. chrome.storage.local is the same store the rest of the extension uses.
function loadPanes(): Promise<Pane[]> {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get([STORAGE_KEY], r => {
        const saved = r?.[STORAGE_KEY];
        resolve(Array.isArray(saved) && saved.length ? (saved as Pane[]) : DEFAULT_PANES);
      });
    } catch {
      resolve(DEFAULT_PANES);
    }
  });
}

function savePanes(panes: Pane[]): void {
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: panes });
  } catch {
    /* storage unavailable */
  }
}

export default function App() {
  const [panes, setPanes] = useState<Pane[]>(DEFAULT_PANES);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadPanes().then(p => {
      setPanes(p);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (ready) savePanes(panes);
  }, [panes, ready]);

  const update = (next: Pane[]) => setPanes(next);
  const availableToAdd = PROVIDERS.filter(p => !panes.some(pn => pn.providerId === p.id && !pn.agentId));

  return (
    <div className="hub-root">
      <div className="hub-bar">
        <span className="hub-title">PierCode 多 AI 工作台</span>
        <span className="hub-hint">所有面板同屏前台运行，互不抢焦点</span>
        <div className="hub-add">
          {availableToAdd.map(p => (
            <button key={p.id} className="hub-add-btn" onClick={() => update(addPane(panes, p.id))}>
              + {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hub-grid">
        {panes.map((pane, i) => {
          const provider = PROVIDERS_BY_ID[pane.providerId];
          return (
            <div className="hub-pane" key={pane.key}>
              <div className="hub-pane-head">
                <span className="hub-pane-name">
                  {provider?.label ?? pane.providerId}
                  {pane.agentId ? <span className="hub-pane-worker"> · worker {pane.agentId.slice(0, 12)}</span> : null}
                </span>
                <span className="hub-pane-ctrl">
                  <button title="左移" disabled={i === 0} onClick={() => update(movePane(panes, i, i - 1))}>◀</button>
                  <button title="右移" disabled={i === panes.length - 1} onClick={() => update(movePane(panes, i, i + 1))}>▶</button>
                  <button title="关闭" onClick={() => update(removePane(panes, pane.key))}>✕</button>
                </span>
              </div>
              {/* Resident iframe: never keyed by index so reorder doesn't reload it. */}
              <iframe className="hub-pane-frame" src={paneSrc(pane)} title={pane.key} />
            </div>
          );
        })}
        {panes.length === 0 && <div className="hub-empty">用上方按钮添加 AI 面板</div>}
      </div>
    </div>
  );
}
