import { expect, mock, test } from 'claude-code/testing'
import type { ModelUsage, On, UsageUnit } from 'claude-code'

const TOOL = 'mcp__context-coach__advise'
const HANDOFF = 'mcp__context-coach__handoff'
const SURFACES = ['terminal', 'desktop'] as const

const band = <S extends 'terminal' | 'desktop'>(surface: S, isWorking = false) => ({
  plugin: 'context-coach',
  surface,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking,
    maxRows: 6,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
})

const fill = (tokens: number) => ({
  context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
  rateLimits: [],
  changed: ['context'] as UsageUnit[],
})

// Stands in for the engine beneath the plugin: the measurement echoes.
const engine = (on: On) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
}

const typed = (text: string) => ({
  text,
  origin: { kind: 'composer' as const },
  wait: false,
})

test('under the threshold the band shows the meter, on every surface', async ($, on) => {
  engine(on)
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(fill(80_000))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(band(surface))
    const row = await ui.find({ type: 'Text', text: /上下文/ })
    expect(row?.text).toBe('上下文 8万 / 100万 · 15万 时提醒')
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
    await ui.unmount()
  }
})

test('past the threshold a typed prompt carries the note; under it none', async ($, on) => {
  engine(on)
  const seen: string[][] = []
  on('prompt.submit', (_, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text, context: e.context ?? [] }
  })

  await $.session.measure(fill(80_000))
  await $.prompt.submit(typed('first'))
  await $.session.measure(fill(160_000))
  await $.prompt.submit(typed('second'))

  expect(seen[0]).toEqual([])
  expect(seen[1]?.length).toBe(1)
  expect(seen[1]?.[0]).toContain('[context-coach]')
  expect(seen[1]?.[0]).toContain('160k')
})

test('compact advice is recommended and one press runs /compact with its focus', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const ran: { command: string; args: string }[] = []
  on('command.run', (_, e) => {
    ran.push({ command: e.command, args: e.args })
    return { text: '' }
  })
  on('session.compact', () => ({
    messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }],
    tokensAfter: 20_000,
  }))

  await $.session.measure(fill(160_000))
  const told = await $.tool.call({
    tool: TOOL,
    verdict: 'compact',
    reason: '下一步还要接着改这个项目',
    focus: 'keep plan.md and the open bug',
  })
  expect(told.deny).toBe(undefined)

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /建议压缩/ }))?.text).toBe(
    '建议压缩 · 上下文 16万 / 100万',
  )
  expect((await ui.find({ type: 'Text', text: /接着改/ }))?.text).toBe('下一步还要接着改这个项目')

  await $.ui.press({ plugin: 'context-coach', key: 'compact' })
  await clock.advance(0)
  expect(ran).toEqual([{ command: 'compact', args: 'keep plan.md and the open bug' }])

  // The engine runs /compact: its compaction reaches the mod's hook.
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user' as const, text: 'hi', toolUses: [] }],
  })
  expect((await ui.find({ type: 'Text', text: /已压缩/ }))?.text).toBe(
    '已压缩 · 下一轮结束后显示上下文大小',
  )
  await ui.unmount()
})

// A compaction takes about a minute: the press must not wait for it, or the
// app cuts the press hook off at its 10 s budget.
test('a press returns at once while /compact still runs', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  let finish = () => {}
  const running = new Promise<void>(resolve => {
    finish = resolve
  })
  let ran = 0
  on('command.run', async () => {
    ran += 1
    await running
    return { text: '' }
  })

  await $.session.measure(fill(160_000))
  const ui = await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'compact' })
  await clock.advance(0)
  expect(ran).toBe(1)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('正在压缩对话…')

  finish()
  await clock.advance(0)
  expect((await ui.find({ type: 'Text', text: /上下文/ }))?.text).toBe(
    '上下文 16万 / 100万 · 已超过 15万',
  )
  await ui.unmount()
})

test('a task still running is told to finish first', async ($, on) => {
  engine(on)
  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'wait', reason: '还在改第二个文件' })

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /任务还没完成/ }))?.text).toBe(
    '上下文 16万 / 100万 · 任务还没完成，做完后再压缩',
  )
  await ui.unmount()
})

test('a new conversation is confirmed first, then runs /clear', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  let ran: string | undefined
  on('command.run', (_, e) => {
    ran = e.command
    return { text: '' }
  })

  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'new_session', reason: '这个任务已经做完了' })

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /建议开新对话/ }))?.text).toBe(
    '建议开新对话 · 上下文 16万 / 100万',
  )
  await $.ui.press({ plugin: 'context-coach', key: 'new' })
  expect(ran).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /清空当前对话/ })).not.toBe(undefined)

  await $.ui.press({ plugin: 'context-coach', key: 'clear-yes' })
  await clock.advance(0)
  expect(ran).toBe('clear')
  expect(await ui.find({ type: 'Text' })).toBe(undefined)
  await ui.unmount()
})

test('carrying on past an advice stays quiet for another 50k', async ($, on) => {
  engine(on)
  const seen: string[][] = []
  on('prompt.submit', (_, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text, context: e.context ?? [] }
  })

  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'compact', reason: 'r' })
  await $.prompt.submit(typed('keep going'))
  await $.session.measure(fill(215_000))
  await $.prompt.submit(typed('and more'))

  expect(seen[0]).toEqual([])
  expect(seen[1]?.length).toBe(1)
})

test('a verdict outside the three is refused', async ($, on) => {
  engine(on)
  const told = await $.tool.call({ tool: TOOL, verdict: 'maybe', reason: 'r' })
  expect(told.deny).toContain('verdict')
})

test('no buttons while a turn runs', async ($, on) => {
  engine(on)
  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'compact', reason: 'r' })

  const ui = await $.ui.mount(band('desktop', true))
  expect(await ui.find({ type: 'Text', text: /建议压缩/ })).not.toBe(undefined)
  expect(await ui.find({ key: 'compact' })).toBe(undefined)
  await ui.unmount()
})

test('the threshold follows the setting', { options: { threshold: 100_000 } }, async ($, on) => {
  engine(on)
  await $.session.measure(fill(120_000))

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /已超过/ }))?.text).toBe(
    '上下文 12万 / 100万 · 已超过 10万',
  )
  await ui.unmount()
})

// Core's tokensAfter (here 16k) leaves out the system prompt and tools, so
// the band shows no number until the next turn's measurement (here 77k).
test("the person's own /compact settles the advice; the size waits for the next turn", async ($, on) => {
  engine(on)
  on('session.compact', () => ({
    messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }],
    tokensAfter: 16_000,
    usage: { input_tokens: 0, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0, output_tokens: 3_000 },
  }))

  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'compact', reason: 'r' })
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user' as const, text: 'hi', toolUses: [] }],
  })

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('已压缩 · 下一轮结束后显示上下文大小')
  expect(await ui.find({ key: 'compact' })).toBe(undefined)
  // The summary's own request is counted.
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话已用 15.3万 token（缓存读 15万 · 输出 3000） · 上一轮 15.3万',
  )

  await $.session.measure(fill(77_000))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 7.7万 / 100万 · 15万 时提醒')
  await ui.unmount()
})

const turnEnds = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' as const }

// Stands in for the rest of the engine a handoff reaches.
const handoffEngine = (on: On) => {
  const seen = { prompts: [] as { text: string; asUser: boolean }[], ran: [] as string[], filled: [] as string[] }
  on('prompt.submit', (_, e) => {
    const origin = e.origin as { kind: string; asUser?: true }
    seen.prompts.push({ text: e.text, asUser: origin.asUser === true })
    return { text: e.text, context: e.context ?? [] }
  })
  on('command.run', (_, e) => {
    seen.ran.push(e.command)
    return { text: '' }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', () => ({ value: undefined }))
  return seen
}

test('a handoff: Claude writes a note, the conversation clears, the note fills the box', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const seen = handoffEngine(on)
  on('prompt.fill', (_, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })

  await $.session.measure(fill(160_000))
  const ui = await $.ui.mount(band('desktop'))

  await $.ui.press({ plugin: 'context-coach', key: 'handoff' })
  expect(await ui.find({ type: 'Text', text: /交接摘要/ })).not.toBe(undefined)
  expect(seen.prompts.length).toBe(0)

  await $.ui.press({ plugin: 'context-coach', key: 'handoff-yes' })
  await clock.advance(0)
  expect(seen.prompts[0]?.text).toContain('handoff note')
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Claude 正在写交接摘要…')

  const told = await $.tool.call({ tool: HANDOFF, note: '目标：给插件加交接功能。下一步：试用。' })
  expect(told.deny).toBe(undefined)
  expect(seen.ran).toEqual([])

  await $.turn.complete(turnEnds)
  await clock.advance(10)
  expect(seen.ran).toEqual(['clear'])
  expect(seen.filled).toEqual(['目标：给插件加交接功能。下一步：试用。'])
  expect(await ui.find({ type: 'Text' })).toBe(undefined)
  await ui.unmount()
})

test('when the box cannot take the note, the band offers to send it', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const seen = handoffEngine(on)
  on('prompt.fill', () => ({ isFilled: false }))

  await $.session.measure(fill(160_000))
  const ui = await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'handoff' })
  await $.ui.press({ plugin: 'context-coach', key: 'handoff-yes' })
  await clock.advance(0)
  await $.tool.call({ tool: HANDOFF, note: 'NOTE' })
  await $.turn.complete(turnEnds)
  await clock.advance(10)

  expect((await ui.find({ type: 'Text', text: /交接摘要/ }))?.text).toBe('交接摘要已准备好')
  await $.ui.press({ plugin: 'context-coach', key: 'note-send' })
  await clock.advance(0)
  expect(seen.prompts.at(-1)).toEqual({ text: 'NOTE', asUser: true })
  await ui.unmount()
})

test('a turn that ends without a note clears nothing', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const seen = handoffEngine(on)

  await $.session.measure(fill(160_000))
  const ui = await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'handoff' })
  await $.ui.press({ plugin: 'context-coach', key: 'handoff-yes' })
  await clock.advance(0)
  await $.turn.complete(turnEnds)
  await clock.advance(10)

  expect(seen.ran).toEqual([])
  expect((await ui.find({ type: 'Text', text: /上下文/ }))?.text).toBe(
    '上下文 16万 / 100万 · 已超过 15万',
  )
  await ui.unmount()
})

test('the handoff tool refuses a note nobody asked for', async ($, on) => {
  engine(on)
  const told = await $.tool.call({ tool: HANDOFF, note: 'x' })
  expect(told.deny).toContain('handoff')
})

test('a /compact that throws shows the reason and puts it in the box', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const filled: string[] = []
  on('command.run', () => {
    throw new Error('not available here')
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'compact', reason: 'r', focus: 'keep plan.md' })
  const ui = await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'compact' })
  await clock.advance(0)

  expect(filled).toEqual(['/compact keep plan.md'])
  expect(toasts[0]).toContain('没能自动执行')
  expect((await ui.find({ type: 'Text', text: /建议压缩/ }))?.text).toBe(
    '建议压缩 · 上下文 16万 / 100万',
  )
  await ui.unmount()
})

test('a /clear that throws puts /clear in the box', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  const filled: string[] = []
  on('command.run', () => {
    throw new Error('not available here')
  })
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', () => ({ value: undefined }))

  await $.session.measure(fill(160_000))
  await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'new' })
  await $.ui.press({ plugin: 'context-coach', key: 'clear-yes' })
  await clock.advance(0)

  expect(filled).toEqual(['/clear'])
})


const used = (cacheRead: number, cacheWrite: number, input: number, output: number): ModelUsage => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

// Stands in for the API: each request answers with the next usage given.
const api = (on: On, usages: ModelUsage[]) => {
  let i = 0
  on('turn.step', async function* (_, e) {
    const u = usages[i++]
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: u === undefined ? null : { ...u, model: 'claude-opus-5-5' },
    }
  })
}

test('each request counts as soon as it answers; a new turn starts its own count', async ($, on) => {
  engine(on)
  api(on, [used(50_000, 2_000, 100, 900), used(60_000, 1_000, 0, 1_000), used(0, 4_500, 500, 5_000), used(100_000, 0, 0, 0)])
  const request = async (turnId: string, agentId?: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of stream) {
      // no chunks
    }
    return stream.result
  }

  await $.session.measure(fill(80_000))
  const ui = await $.ui.mount(band('desktop', true))
  expect(await ui.find({ type: 'Text', text: /本对话/ })).toBe(undefined)

  await request('t1')
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话已用 5.3万 token（缓存读 5万 · 输出 900） · 本轮 5.3万',
  )
  await request('t1')
  // A subagent's request folds into the turn that spawned it.
  await request('x9', 'agent-1')
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话已用 12.5万 token（缓存读 11万 · 输出 6900） · 本轮 12.5万',
  )
  await request('t2')
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话已用 22.5万 token（缓存读 21万 · 输出 6900） · 本轮 10万',
  )
  // The meter stays first.
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 8万 / 100万 · 15万 时提醒')
  await ui.unmount()

  const idle = await $.ui.mount(band('desktop'))
  expect((await idle.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话已用 22.5万 token（缓存读 21万 · 输出 6900） · 上一轮 10万',
  )
  await idle.unmount()
})

test("the plan's windows show as they are measured", async ($, on) => {
  engine(on)
  await $.session.measure({
    context: { tokens: 80_000, window: 1_000_000, percent: 8 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23 },
      { kind: 'seven_day', percentUsed: 41.5 },
    ],
    changed: ['context', 'rateLimits'] as UsageUnit[],
  })
  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: /额度/ }))?.text).toBe('5小时额度 23% · 7天额度 41.5%')
  await ui.unmount()
})

test('a new conversation starts the count over', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  api(on, [used(50_000, 0, 0, 0)])
  on('command.run', () => ({ text: '' }))

  await $.session.measure(fill(160_000))
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // no chunks
  }
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ type: 'Text', text: /本对话/ })).not.toBe(undefined)

  await $.ui.press({ plugin: 'context-coach', key: 'new' })
  await $.ui.press({ plugin: 'context-coach', key: 'clear-yes' })
  await clock.advance(0)
  expect(await ui.find({ type: 'Text', text: /本对话/ })).toBe(undefined)
  await ui.unmount()
})

test('the usage row follows its setting', { options: { showUsage: false } }, async ($, on) => {
  engine(on)
  api(on, [used(50_000, 0, 0, 0)])
  await $.session.measure(fill(80_000))
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // no chunks
  }
  const ui = await $.ui.mount(band('desktop'))
  expect(await ui.find({ type: 'Text', text: /本对话/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 8万 / 100万 · 15万 时提醒')
  await ui.unmount()
})
