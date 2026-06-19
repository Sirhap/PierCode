// Minimal CDP Accessibility.getFullAXTree payload shaped like the Go test data.
// RootWebArea → button "Submit", link "Home" (both actionable → get refs).
import type { AXTreeResponse } from '../../../background/browser/snapshot'

export const AX_TREE: AXTreeResponse = {
  nodes: [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Test Page' }, childIds: ['2', '3'], backendDOMNodeId: 100 },
    { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Submit' }, childIds: [], backendDOMNodeId: 101 },
    { nodeId: '3', parentId: '1', role: { value: 'link' }, name: { value: 'Home' }, childIds: [], backendDOMNodeId: 102,
      properties: [{ name: 'url', value: { value: 'https://x.com/home' } }] },
  ],
}
