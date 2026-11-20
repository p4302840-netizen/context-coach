import { expect, mock, test } from 'claude-code/testing'
import type { ModelUsage, On, SessionContextBreakdown, UsageUnit } from 'claude-code'

const TOOL = 'mcp__context-coach__advise'
const HANDOFF = 'mcp__context-coach__handoff'
const SURFACES = ['terminal', 'desktop'] as const
// The band's words are pinned to Chinese here; the English ones have their own tests.
const ZH = { options: { language: 'zh' } }

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

test('under the threshold the band shows the meter, on every surface', ZH, async ($, on) => {
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

test('past the threshold a typed prompt carries the note; under it none', ZH, async ($, on) => {
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

test('compact advice is recommended and one press runs /compact with its focus', ZH, async ($, on) => {
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
test('a press returns at once while /compact still runs', ZH, async ($, on) => {
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

test('a task still running is told to finish first', ZH, async ($, on) => {
  engine(on)
  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'wait', reason: '还在改第二个文件' })

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /任务还没完成/ }))?.text).toBe(
    '上下文 16万 / 100万 · 任务还没完成，做完后再压缩',
  )
  await ui.unmount()
})

test('a new conversation is confirmed first, then runs /clear', ZH, async ($, on) => {
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

test('carrying on past an advice stays quiet for another 50k', ZH, async ($, on) => {
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

test('a verdict outside the three is refused', ZH, async ($, on) => {
  engine(on)
  const told = await $.tool.call({ tool: TOOL, verdict: 'maybe', reason: 'r' })
  expect(told.deny).toContain('verdict')
})

test('no buttons while a turn runs', ZH, async ($, on) => {
  engine(on)
  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'compact', reason: 'r' })

  const ui = await $.ui.mount(band('desktop', true))
  expect(await ui.find({ type: 'Text', text: /建议压缩/ })).not.toBe(undefined)
  expect(await ui.find({ key: 'compact' })).toBe(undefined)
  await ui.unmount()
})

test('the threshold follows the setting', { options: { language: 'zh', threshold: 100_000 } }, async ($, on) => {
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
test("the person's own /compact settles the advice; the size waits for the next turn", ZH, async ($, on) => {
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
    '本对话 ≈ 3万 token（按输入价折算，实际处理 15.3万） · 上一轮 ≈ 3万',
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

test('a handoff: Claude writes a note, the conversation clears, the note fills the box', ZH, async ($, on) => {
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

test('when the box cannot take the note, the band offers to send it', ZH, async ($, on) => {
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

test('a turn that ends without a note clears nothing', ZH, async ($, on) => {
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

test('the handoff tool refuses a note nobody asked for', ZH, async ($, on) => {
  engine(on)
  const told = await $.tool.call({ tool: HANDOFF, note: 'x' })
  expect(told.deny).toContain('handoff')
})

test('a /compact that throws shows the reason and puts it in the box', ZH, async ($, on) => {
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

test('a /clear that throws puts /clear in the box', ZH, async ($, on) => {
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


type Used = ModelUsage & { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }

const used = (cacheRead: number, cacheWrite: number, input: number, output: number): Used => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

// Stands in for the API: each request answers with the next usage given.
const api = (on: On, usages: Used[]) => {
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

const MINUTE = 60_000

test('each request counts as soon as it answers, priced as input tokens; a new turn starts its own count', ZH, async ($, on) => {
  engine(on)
  mock.clock(on)
  // Weighted: 12100, 12250, 31125 (a subagent's), 10000.
  api(on, [used(50_000, 2_000, 100, 900), used(60_000, 1_000, 0, 1_000), used(0, 4_500, 500, 5_000), used(100_000, 0, 0, 0)])
  const request = async (turnId: string, agentId?: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of stream) {
      // no chunks
    }
  }

  await $.session.measure(fill(80_000))
  const ui = await $.ui.mount(band('desktop', true))
  expect(await ui.find({ type: 'Text', text: /本对话/ })).toBe(undefined)

  await request('t1')
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话 ≈ 1.2万 token（按输入价折算，实际处理 5.3万） · 本轮 ≈ 1.2万',
  )
  await request('t1')
  // A subagent's request folds into the turn that spawned it.
  await request('x9', 'agent-1')
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话 ≈ 5.5万 token（按输入价折算，实际处理 12.5万） · 本轮 ≈ 5.5万',
  )
  await request('t2')
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话 ≈ 6.5万 token（按输入价折算，实际处理 22.5万） · 本轮 ≈ 1万',
  )
  // The meter stays first.
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 8万 / 100万 · 15万 时提醒')
  await ui.unmount()

  // Idle: the latest turn, and until when the cache holds.
  const idle = await $.ui.mount(band('desktop'))
  expect((await idle.find({ type: 'Text', text: /本对话/ }))?.text).toMatch(
    /^本对话 ≈ 6\.5万 token（按输入价折算，实际处理 22\.5万） · 上一轮 ≈ 1万 · 缓存保留到 \d\d:\d\d$/,
  )
  await idle.unmount()
})

test("the plan's windows show as they are measured", ZH, async ($, on) => {
  engine(on)
  await $.session.measure({
    context: { tokens: 80_000, window: 1_000_000, percent: 8 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23 },
      { kind: 'seven_day', percentUsed: 41.5 },
    ],
    cost: { usd: 1.5 },
    changed: ['context', 'rateLimits', 'cost'] as UsageUnit[],
  })
  const ui = await $.ui.mount(band('terminal'))
  // On a subscription the plan's windows say it; the dollar estimate stays out.
  expect((await ui.find({ type: 'Text', text: /额度/ }))?.text).toBe('5小时额度 23% · 7天额度 41.5%')
  await ui.unmount()
})

test('off a subscription the cost estimate shows instead', ZH, async ($, on) => {
  engine(on)
  await $.session.measure({
    context: { tokens: 80_000, window: 1_000_000, percent: 8 },
    rateLimits: [],
    cost: { usd: 1.234 },
    changed: ['context', 'cost'] as UsageUnit[],
  })
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /估算/ }))?.text).toBe('约 $1.23（估算）')
  await ui.unmount()
})

test('a new conversation starts the count over', ZH, async ($, on) => {
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

test('the usage row follows its setting', { options: { language: 'zh', showUsage: false } }, async ($, on) => {
  engine(on)
  mock.clock(on)
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

test('an hour cache over a large context warns once it lapses, until the next request', ZH, async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  api(on, [
    { ...used(110_000, 2_000, 0, 500), ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2_000 },
    used(112_000, 0, 0, 100),
  ])
  const request = async (turnId: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    for await (const _ of stream) {
      // no chunks
    }
  }

  await $.session.measure(fill(120_000))
  await request('t1')
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /缓存保留到/ }))?.text).toMatch(/缓存保留到 \d\d:\d\d$/)

  await clock.advance(59 * MINUTE)
  expect(await ui.find({ type: 'Text', text: /缓存已过期/ })).toBe(undefined)
  await clock.advance(2 * MINUTE)
  expect((await ui.find({ type: 'Text', text: /缓存已过期/ }))?.text).toBe('缓存已过期 · 上下文 12万 / 100万')
  expect((await ui.find({ type: 'Text', text: /全价/ }))?.text).toBe(
    '下一条消息要按全价重读这 12万 token，比有缓存时贵 10 倍以上。用不到这段对话了，开新对话最省',
  )
  expect(await ui.find({ type: 'Text', text: /缓存保留到/ })).toBe(undefined)

  await $.ui.press({ plugin: 'context-coach', key: 'cold-ok' })
  expect(await ui.find({ type: 'Text', text: /缓存已过期/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 12万 / 100万 · 15万 时提醒')

  // The next request warms it again, and the hour it named still holds.
  await request('t2')
  await clock.advance(10 * MINUTE)
  expect(await ui.find({ type: 'Text', text: /缓存已过期/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /缓存保留到/ })).not.toBe(undefined)
  await ui.unmount()
})

test('a cache that names no lifetime lapses after five minutes; 新对话 asks first', ZH, async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  api(on, [used(110_000, 1_000, 0, 100)])
  await $.session.measure(fill(110_000))
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // no chunks
  }
  const ui = await $.ui.mount(band('desktop'))
  await clock.advance(5 * MINUTE)
  expect(await ui.find({ type: 'Text', text: /缓存已过期/ })).not.toBe(undefined)

  await $.ui.press({ plugin: 'context-coach', key: 'cold-new' })
  expect(await ui.find({ type: 'Text', text: /清空当前对话/ })).not.toBe(undefined)
  await ui.unmount()
})

test('a lapsed cache over a small context says nothing', ZH, async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  api(on, [used(60_000, 1_000, 0, 100)])
  await $.session.measure(fill(70_000))
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // no chunks
  }
  const ui = await $.ui.mount(band('desktop'))
  await clock.advance(10 * MINUTE)
  expect(await ui.find({ type: 'Text', text: /缓存已过期/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 7万 / 100万 · 15万 时提醒')
  await ui.unmount()
})


const withLimit = (tokens: number, fiveHour: number) => ({
  context: { tokens, window: 1_000_000, percent: Math.round(tokens / 10_000) },
  rateLimits: [{ kind: 'five_hour', percentUsed: fiveHour }],
  changed: ['context', 'rateLimits'] as UsageUnit[],
})

test('a five-hour limit past 80% brings the reminder forward to two thirds', ZH, async ($, on) => {
  engine(on)
  const seen: string[][] = []
  on('prompt.submit', (_, e) => {
    seen.push([...(e.context ?? [])])
    return { text: e.text, context: e.context ?? [] }
  })

  await $.session.measure(withLimit(110_000, 50))
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 11万 / 100万 · 15万 时提醒')
  await $.prompt.submit(typed('first'))
  expect(seen[0]).toEqual([])

  await $.session.measure(withLimit(110_000, 85))
  expect((await ui.find({ type: 'Text' }))?.text).toBe(
    '上下文 11万 / 100万 · 已超过 10万（5小时额度已用 85%，提前提醒）',
  )
  await $.prompt.submit(typed('second'))
  expect(seen[1]?.[0]).toContain('100k reminder threshold')
  expect(seen[1]?.[0]).toContain('five-hour plan limit is 85% used')
  await ui.unmount()
})

test('the early reminder follows its setting', { options: { language: 'zh', quotaAlert: 0 } }, async ($, on) => {
  engine(on)
  await $.session.measure(withLimit(110_000, 95))
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 11万 / 100万 · 15万 时提醒')
  await ui.unmount()
})

const breakdown = {
  totalTokens: 77_000,
  categories: [
    { name: 'System prompt', tokens: 10_000, kind: 'used', isDeferred: false, color: 'a' },
    { name: 'System tools', tokens: 20_000, kind: 'used', isDeferred: false, color: 'a' },
    { name: 'MCP tools', tokens: 15_000, kind: 'used', isDeferred: false, color: 'a' },
    { name: 'MCP tools (deferred)', tokens: 40_000, kind: 'deferred', isDeferred: true, color: 'a' },
    { name: 'Skills', tokens: 2_000, kind: 'used', isDeferred: false, color: 'a' },
    { name: 'Messages', tokens: 30_000, kind: 'used', isDeferred: false, color: 'a' },
    { name: 'Free space', tokens: 900_000, kind: 'free', isDeferred: false, color: 'a' },
  ],
  mcpTools: [
    { name: 'mcp__browser__click', serverName: 'browser', tokens: 5_000, isLoaded: true },
    { name: 'mcp__browser__read', serverName: 'browser', tokens: 4_000, isLoaded: true },
    { name: 'mcp__docs__write', serverName: 'docs', tokens: 6_000, isLoaded: true },
    { name: 'mcp__mail__send', serverName: 'mail', tokens: 30_000, isLoaded: false },
  ],
} as unknown as SessionContextBreakdown

test('详情 lists what the context holds and the largest connectors', ZH, async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 77_000, window: 1_000_000, breakdown }, rateLimits: [] },
  }))

  await $.session.measure(fill(77_000))
  const ui = await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'details' })
  await clock.advance(0)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文构成（共 7.7万）')
  expect((await ui.find({ type: 'Text', text: /消息/ }))?.text).toBe(
    '消息 3万 · 系统工具 2万 · MCP 工具 1.5万 · 系统提示 1万 · 技能 2000',
  )
  expect((await ui.find({ type: 'Text', text: /连接器/ }))?.text).toBe(
    '连接器占用最多：browser 9000 · docs 6000。用不到的关掉，每个新对话都能少这些',
  )

  await $.ui.press({ plugin: 'context-coach', key: 'details-close' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('上下文 7.7万 / 100万 · 15万 时提醒')
  await ui.unmount()
})

test('详情 says so when the breakdown cannot be read', ZH, async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  on('session.usage', () => {
    throw new Error('not here')
  })
  await $.session.measure(fill(77_000))
  const ui = await $.ui.mount(band('desktop'))
  await $.ui.press({ plugin: 'context-coach', key: 'details' })
  await clock.advance(0)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('没能读取上下文构成')
  await ui.unmount()
})

test('a resumed conversation carries on from its saved count; the store keeps the newest 50', ZH, async ($, on) => {
  engine(on)
  mock.clock(on)
  const entries: Record<string, unknown> = {}
  for (let i = 0; i < 52; i++) entries[`spend:old${i}`] = { requests: 1 }
  entries['spend:s1'] = {
    requests: 10,
    input: 0,
    cacheRead: 900_000,
    cacheWrite: 10_000,
    output: 5_000,
    weighted: 120_000,
    turnId: 't9',
    turnWeighted: 30_000,
  }
  // The store, in memory, in insertion order.
  const store = new Map(Object.entries(entries))
  const deleted: string[] = []
  const saved: { key: string; value: unknown }[] = []
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e) => {
    deleted.push(e.key)
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.set', (_, e) => {
    saved.push({ key: e.key, value: e.value })
    store.set(e.key, e.value)
    return { value: undefined }
  })
  api(on, [used(50_000, 2_000, 100, 900)])
  on('session.id', () => ({ value: 's1' }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure(fill(80_000))

  const ui = await $.ui.mount(band('desktop', true))
  expect((await ui.find({ type: 'Text', text: /本对话/ }))?.text).toBe(
    '本对话 ≈ 12万 token（按输入价折算，实际处理 91.5万） · 本轮 ≈ 3万',
  )
  // 53 kept, 50 stay: the three oldest go.
  expect(deleted).toEqual(['spend:old0', 'spend:old1', 'spend:old2'])

  const stream = $.turn.step({ turnId: 't10', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // no chunks
  }
  expect(saved.at(-1)?.key).toBe('spend:s1')
  expect((saved.at(-1)?.value as { requests: number }).requests).toBe(11)
  await ui.unmount()
})

test('in English the band speaks English, with k and M', { options: { language: 'en' } }, async ($, on) => {
  engine(on)
  mock.clock(on)
  api(on, [used(50_000, 2_000, 100, 900)])

  await $.session.measure(fill(80_000))
  const ui = await $.ui.mount(band('terminal', true))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Context 80k / 1M · reminder at 150k')
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _ of stream) {
    // no chunks
  }
  expect((await ui.find({ type: 'Text', text: /conversation/ }))?.text).toBe(
    'This conversation ≈ 12k tokens (input-priced; 53k processed) · this turn ≈ 12k',
  )
  await ui.unmount()

  await $.session.measure(fill(160_000))
  await $.tool.call({ tool: TOOL, verdict: 'compact', reason: 'the next step builds on this' })
  const over = await $.ui.mount(band('desktop'))
  expect((await over.find({ type: 'Text' }))?.text).toBe('Compact suggested · Context 160k / 1M')
  await over.unmount()
})
