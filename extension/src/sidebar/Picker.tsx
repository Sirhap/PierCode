import { useEffect, useRef, useState } from 'react'

export interface PickerItem {
  label: string
  sub?: string
  value: string
}

interface PickerProps {
  items: PickerItem[]
  onSelect: (item: PickerItem) => void
  onClose: () => void
}

/**
 * Generic dropdown picker with keyboard navigation.
 * Used by /skills and @file autocomplete.
 */
export default function Picker({ items, onSelect, onClose }: PickerProps) {
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset selection when items change
  useEffect(() => { setSelected(0) }, [items.length])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  // Keyboard handler — only intercept navigation keys, let others pass through
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setSelected(prev => Math.min(prev + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setSelected(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (items[selected]) onSelect(items[selected])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
      // All other keys (Tab, typing, etc.) pass through to the input
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [items, selected, onSelect, onClose])

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.picker-popup')) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (items.length === 0) return null

  return (
    <div className="picker-popup absolute bottom-full left-0 right-0 mb-1 max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl z-50">
      <div ref={listRef}>
        {items.map((item, i) => (
          <div
            key={`${i}-${item.value}`}
            className={`px-3 py-1.5 text-xs cursor-pointer flex items-center gap-2 ${
              i === selected
                ? 'bg-blue-600/30 text-blue-200'
                : 'text-gray-300 hover:bg-gray-800'
            }`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => onSelect(item)}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.sub && <span className="text-gray-500 truncate text-[10px]">{item.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
