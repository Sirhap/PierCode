import type { PickerItem } from './Picker'

/**
 * Built-in @@ task templates. Selecting one inserts a sub-task instruction that
 * nudges the main AI to emit a spawn_agent piercode-tool block. `value` is the
 * text inserted into the input (replacing the @@token); `label`/`sub` are display.
 */
export const AGENT_TEMPLATES: PickerItem[] = [
  {
    label: '@@review',
    sub: '审查最近改动的代码',
    value: '请派一个子 agent 审查当前改动的代码，找出 bug、风格问题与改进点，汇总结论。',
  },
  {
    label: '@@test',
    sub: '运行测试并修复失败',
    value: '请派一个子 agent 运行项目测试，若有失败逐项定位并修复，报告结果。',
  },
  {
    label: '@@explore',
    sub: '探索代码库结构',
    value: '请派一个子 agent 探索代码库结构，梳理关键模块、入口与数据流，输出地图。',
  },
]

/** Filter templates by the text typed after @@ (case-insensitive substring on label/sub). */
export function filterAgentTemplates(query: string): PickerItem[] {
  if (!query) return AGENT_TEMPLATES
  const q = query.toLowerCase()
  return AGENT_TEMPLATES.filter(
    t => t.label.toLowerCase().includes(q) || (t.sub || '').toLowerCase().includes(q),
  )
}
