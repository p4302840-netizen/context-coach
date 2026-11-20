import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Advice, Ctx, Handoff, Quota, Spend, Verdict } from '../types'

const IDLE: Handoff = { stage: 'idle', note: '' }
const NO_SPEND: Spend = {
  requests: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  turnId: '',
  turnTokens: 0,
}
const NO_QUOTA: Quota[] = []

// Change a tag when that value's fields change: a reload keeps old values.
const ctx = atom({ plugin: 'context-coach', key: 'ctx' } as const, null, {
  shape: 'ctx-1',
})
const advice = atom({ plugin: 'context-coach', key: 'advice' } as const, null, {
  shape: 'advice-1',
})
const handoff = atom({ plugin: 'context-coach', key: 'handoff' } as const, IDLE, {
  shape: 'handoff-1',
})
const spend = atom({ plugin: 'context-coach', key: 'spend' } as const, NO_SPEND, {
  shape: 'spend-1',
})
const quota = atom({ plugin: 'context-coach', key: 'quota' } as const, NO_QUOTA, {
  shape: 'quota-1',
})
const quietUntil = atom({ plugin: 'context-coach', key: 'quietUntil' } as const, 0)
const isHidden = atom({ plugin: 'context-coach', key: 'isHidden' } as const, false)
const isConfirmingClear = atom(
  { plugin: 'context-coach', key: 'isConfirmingClear' } as const,
  false,
)
const isBusy = atom({ plugin: 'context-coach', key: 'isBusy' } as const, false)

const TOOL = 'mcp__context-coach__advise'
const HANDOFF_TOOL = 'mcp__context-coach__handoff'
const DEFAULT_THRESHOLD = 150_000
// After the person carries on past a compact / new-conversation advice,
// stay quiet until the context grows this much more.
const RENUDGE = 50_000
const VERDICTS: readonly Verdict[] = ['wait', 'compact', 'new_session']
// Prompts the person sent themselves (typed here, from a phone, or the app).
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

/** 8000 → "8000", 162345 → "16.2万", 1000000 → "100万" */
export const wan = (n: number): string => {
  if (n < 10_000) return String(n)
  const v = n / 10_000
  return `${v >= 100 ? Math.round(v) : Number(v.toFixed(1))}万`
}

const k = (n: number): string => `${Math.round(n / 1000)}k`

const tokensOf = (u: ModelUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

// One request's usage added in. A main-thread step of another turn starts
// that turn's count; a subagent's steps, and a compaction's request (no
// turn), fold into the turn that is running.
const tally = (was: Spend, u: ModelUsage, step?: { turnId: string; agentId?: string }): Spend => {
  const isNewTurn = step !== undefined && step.agentId === undefined && step.turnId !== was.turnId
  return {
    requests: was.requests + 1,
    input: was.input + u.input_tokens,
    cacheRead: was.cacheRead + u.cache_read_input_tokens,
    cacheWrite: was.cacheWrite + u.cache_creation_input_tokens,
    output: was.output + u.output_tokens,
    turnId: isNewTurn ? step.turnId : was.turnId,
    turnTokens: (isNewTurn ? 0 : was.turnTokens) + tokensOf(u),
  }
}

const QUOTA_NAMES: Record<string, string> = { five_hour: '5小时额度', seven_day: '7天额度' }

/** The usage row: this conversation's tokens, its latest turn's, the plan's windows. */
export const usageLine = (s: Spend, limits: readonly Quota[], isWorking: boolean): string | null => {
  const parts: string[] = []
  if (s.requests > 0) {
    const total = s.input + s.cacheRead + s.cacheWrite + s.output
    parts.push(`本对话已用 ${wan(total)} token（缓存读 ${wan(s.cacheRead)} · 输出 ${wan(s.output)}）`)
    if (s.turnTokens > 0) parts.push(`${isWorking ? '本轮' : '上一轮'} ${wan(s.turnTokens)}`)
  }
  for (const limit of limits) {
    parts.push(`${QUOTA_NAMES[limit.kind] ?? '用量上限'} ${limit.percentUsed}%`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

const note = (tokens: number, threshold: number): string =>
  [
    `[context-coach] This conversation's context is ${k(tokens)} tokens, past the user's ${k(threshold)} reminder threshold.`,
    `In the same response as your final reply this turn, call ${TOOL} once:`,
    `- "wait" if the task the user asked for is not finished yet;`,
    `- "compact" if it is finished and the next work likely builds on this conversation (put in focus what the summary must keep: files, decisions, open items);`,
    `- "new_session" if it is finished and nothing pending needs this conversation.`,
    `Write reason as one short sentence in the user's language. Do not mention this note in your reply.`,
  ].join('\n')

const DESCRIPTION =
  "Context coach. Call only when a [context-coach] note asks you to: say whether the user's task is finished and, if so, whether to compact this conversation or start a new one. Call it alongside your final reply; after its result, end the turn without more text."

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: VERDICTS,
      description:
        'wait: task not finished. compact: finished, next work builds on this conversation. new_session: finished, nothing pending needs it.',
    },
    reason: {
      type: 'string',
      description: "One short sentence for the user, in the user's language.",
    },
    focus: {
      type: 'string',
      description: 'For compact: what the summary must keep (files, decisions, open items).',
    },
  },
  required: ['verdict', 'reason'],
}

const HANDOFF_PROMPT = [
  'The user pressed "new conversation with a handoff note". Write a handoff note for a fresh conversation that will see nothing of this one.',
  "Keep only what the next work needs: the goal, where things stand, files and paths, decisions made and why, open items and the next step, and constraints the user stated. Quote paths, names and commands verbatim. Write it in the user's language, as the message the user will send to open the new conversation.",
  `Then call ${HANDOFF_TOOL} with the whole note, and end your turn without more text.`,
].join('\n')

const HANDOFF_DESCRIPTION =
  'Context coach handoff. Call only when the context-coach plugin asks you for a handoff note: pass the whole note. After its result, end the turn without more text.'

const HANDOFF_SCHEMA = {
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description: "The whole handoff note, in the user's language.",
    },
  },
  required: ['note'],
}

const resetAdvice = async ($: EngineInterface): Promise<void> => {
  await update($, advice, () => null)
  await update($, quietUntil, () => 0)
  await update($, isHidden, () => false)
  await update($, isConfirmingClear, () => false)
}

// A compaction stood: the advice is settled, and the size waits for the next
// measurement (core's tokensAfter counts the conversation alone, not the
// system prompt and tools every request carries).
const afterCompact = async ($: EngineInterface): Promise<void> => {
  await resetAdvice($)
  await update($, ctx, fill => (fill ? { window: fill.window, tokens: null, isCompacted: true } : fill))
}

// A /clear stood: nothing of the old conversation is measured any more.
const afterClear = async ($: EngineInterface): Promise<void> => {
  await resetAdvice($)
  await update($, ctx, () => null)
  await update($, spend, () => NO_SPEND)
}

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 120)

// A trail of what the mod saw and did, in debug.log beside plugin.json, so a
// press that seems to do nothing can be traced. The last 200 lines are kept.
// Off unless the `debug` option is on.
const trail: string[] = []
let isLogging = false
const log = ($: EngineInterface, line: string): void => {
  if (!isLogging) return
  trail.push(`${new Date().toISOString()} ${line}`)
  if (trail.length > 200) trail.splice(0, trail.length - 200)
  void $.fs.write(`${$.plugin.root}/debug.log`, `${trail.join('\n')}\n`).catch(() => undefined)
}

// Work that can outlast a hook's 10 s budget (a compaction takes a minute)
// runs on a timer of its own, so the press or turn that asked for it returns
// at once instead of being cut off as overrun.
const later = ($: EngineInterface, what: string, work: () => Promise<unknown>): void => {
  $.clock.after(0, () => {
    work().catch(err => log($, `${what}: failed ${errorText(err)}`))
  })
}

// The fallback that always works: the command in the box, Enter to run it.
const byHand = async ($: EngineInterface, command: string, problem: string): Promise<void> => {
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text: command })).isFilled
  } catch {
    isFilled = false
  }
  const name = command.split(' ')[0]
  $.ui.toast(
    isFilled
      ? `没能自动执行（${problem}）。已把 ${name} 放进输入框，按回车即可`
      : `没能自动执行（${problem}）。请在输入框输入 ${name}`,
  )
}

// Runs /compact as if typed: the path the desktop app runs too, so core
// raises the compaction (and the session.compact hook below settles it).
const compactNow = async ($: EngineInterface, focus: string): Promise<void> => {
  if (await read($, isBusy)) return
  log($, `compact: start (focus ${focus.length} chars)`)
  await update($, isBusy, () => true)
  let problem = ''
  try {
    const ran = await $.command.run({ command: 'compact', args: focus })
    log($, `compact: command.run answered ${JSON.stringify(ran).slice(0, 200)}`)
  } catch (err) {
    problem = errorText(err)
    log($, `compact: command.run threw ${problem}`)
  } finally {
    await update($, isBusy, () => false)
  }
  if (problem !== '') await byHand($, focus ? `/compact ${focus}` : '/compact', problem)
}

// Runs /clear; false (with the person told what to do) when it threw.
const clearConversation = async ($: EngineInterface): Promise<boolean> => {
  log($, 'clear: start')
  try {
    const ran = await $.command.run({ command: 'clear' })
    log($, `clear: command.run answered ${JSON.stringify(ran).slice(0, 200)}`)
  } catch (err) {
    const problem = errorText(err)
    log($, `clear: command.run threw ${problem}`)
    await byHand($, '/clear', problem)
    return false
  }
  await afterClear($)
  return true
}

const clearNow = async ($: EngineInterface): Promise<void> => {
  await update($, isConfirmingClear, () => false)
  await clearConversation($)
}

// Handoff, step 1: Claude writes the note in this conversation (its context
// is cached, so this reads it cheaply) and hands it over with the tool.
const startHandoff = async ($: EngineInterface): Promise<void> => {
  await update($, handoff, () => ({ stage: 'writing', note: '' }))
  try {
    await $.prompt.submit({ text: HANDOFF_PROMPT })
  } catch {
    await update($, handoff, () => IDLE)
    $.ui.toast('没能让 Claude 写交接摘要，请稍后再试')
  }
}

// Handoff, last step: the note goes into the new conversation's prompt box,
// for the person to read, edit and send.
const fillNote = async ($: EngineInterface, text: string): Promise<void> => {
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text })).isFilled
  } catch {
    isFilled = false
  }
  if (isFilled) {
    await update($, handoff, () => IDLE)
    $.ui.toast('交接摘要已放进输入框，看过后发送')
  } else {
    $.ui.toast('没能放进输入框，可以在输入框上方直接发送')
  }
}

// Handoff, step 2: once the turn that wrote the note is over, clear and fill.
const finishHandoff = async ($: EngineInterface, text: string): Promise<void> => {
  // The note waits in the band until it is in the new conversation's box, so
  // a /clear run by hand still finds it there («放进输入框»).
  await update($, handoff, () => ({ stage: 'pending', note: text }))
  if (await clearConversation($)) await fillNote($, text)
}

const sendNote = async ($: EngineInterface, text: string): Promise<void> => {
  await update($, handoff, () => IDLE)
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch {
    await update($, handoff, () => ({ stage: 'pending', note: text }))
    $.ui.toast('没能发送，请稍后再试')
  }
}

export const register: Register = (on, options) => {
  const threshold =
    typeof options.threshold === 'number' && options.threshold > 0
      ? options.threshold
      : DEFAULT_THRESHOLD
  const showMeter = options.showMeter !== false
  const showUsage = options.showUsage !== false
  isLogging = options.debug === true
  let lastDrawn = ''

  // Every press on this mod's own elements, before its handler runs.
  on('ui.press', ($, e, next) => {
    log($, `press: ${e.element} on ${e.surface}`)

    return next(e)
  })

  // The tools Claude reports with: its judgement, and a handoff note.
  on('session.start', async ($, e, next) => {
    log($, `session.start: root ${$.plugin.root}`)
    await $.tool.register({
      name: 'advise',
      description: DESCRIPTION,
      inputSchema: SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'handoff',
      description: HANDOFF_DESCRIPTION,
      inputSchema: HANDOFF_SCHEMA,
      isDeferred: false,
    })

    return next(e)
  })

  // (1) The context size after each main-thread turn.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const fill: Ctx = { tokens: e.context.tokens ?? null, window: e.context.window }
      await update($, ctx, () => fill)
    }
    if (e.changed.includes('rateLimits')) {
      const limits = e.rateLimits.map(r => ({ ...r }))
      await update($, quota, () => limits)
    }

    return next(e)
  })

  // (2) Past the threshold, ask Claude to judge at the end of this turn. The
  // note rides beside the prompt, so the cached conversation stays intact.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !PERSON_ORIGINS.has(e.origin.kind)) return next(e)

    const tokens = (await read($, ctx))?.tokens ?? 0
    const given = await read($, advice)
    if (given && given.verdict !== 'wait') {
      // The person carried on instead: drop the advice, don't nag right away.
      await update($, advice, () => null)
      await update($, quietUntil, () => tokens + RENUDGE)
    }
    if (tokens < threshold || tokens < (await read($, quietUntil))) return next(e)

    return next({ ...e, context: [...(e.context ?? []), note(tokens, threshold)] })
  })

  // (3) Claude's judgement: wait, compact or new_session.
  on('tool.call', { tool: 'mcp__context-coach__advise' }, async ($, e) => {
    const input = e as unknown as { verdict?: unknown; reason?: unknown; focus?: unknown }
    const verdict = VERDICTS.find(v => v === input.verdict)
    if (verdict === undefined) {
      return { deny: 'verdict must be "wait", "compact" or "new_session".' }
    }
    const given: Advice = {
      verdict,
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 300) : '',
      focus: typeof input.focus === 'string' ? input.focus.slice(0, 2000) : '',
      at: (await read($, ctx))?.tokens ?? 0,
    }
    await update($, advice, () => given)
    await update($, isHidden, () => false)
    await update($, isConfirmingClear, () => false)

    return {
      result: 'Shown to the user above the prompt. End your turn now without more text.',
    }
  })

  // The handoff note, only while one was asked for.
  on('tool.call', { tool: 'mcp__context-coach__handoff' }, async ($, e) => {
    const text = (e as unknown as { note?: unknown }).note
    if ((await read($, handoff)).stage !== 'writing') {
      return { deny: 'Call this only when the context-coach plugin asks for a handoff note.' }
    }
    if (typeof text !== 'string' || text.trim() === '') {
      return { deny: 'note must hold the whole handoff note.' }
    }
    await update($, handoff, () => ({ stage: 'ready', note: text.slice(0, 20_000) }))

    return {
      result:
        'Saved. The conversation will be cleared and the note put in the prompt box. End your turn now without more text.',
    }
  })

  // When the turn that wrote the note ends, clear and carry the note over.
  // The clear waits for a timer: a command can't run inside the turn's end.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const carried = await read($, handoff)
    if (carried.stage === 'ready') {
      const text = carried.note
      later($, 'handoff', () => finishHandoff($, text))
    } else if (carried.stage === 'writing') {
      await update($, handoff, () => IDLE)
      $.ui.toast('没拿到交接摘要，对话没有清空')
    }

    return done
  })

  // The person's /compact or the engine's auto-compaction settles it too.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      log($, `session.compact: ${e.trigger}, ${done.skip ?? `stood, ${done.tokensAfter ?? '?'} tokens after`}`)
    }
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) {
      await afterCompact($)
    }
    // The summary's own request counts too (absent when none was made).
    const used = done.skip === undefined ? done.usage : undefined
    if (used !== undefined) await update($, spend, was => tally(was ?? NO_SPEND, used))

    return done
  })

  // Every model request of the conversation, as soon as its response is in.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    const used = response.usage
    if (used !== null) await update($, spend, was => tally(was ?? NO_SPEND, used, e))
    return response
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await afterClear($)

    return next(e)
  })

  // The row above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const canAct = !e.props.isWorking
    if (await read($, isBusy)) return <Text dimColor>正在压缩对话…</Text>

    const carried = await read($, handoff)
    if (carried.stage === 'writing' || carried.stage === 'ready') {
      return <Text dimColor>Claude 正在写交接摘要…</Text>
    }
    if (carried.stage === 'pending') {
      const text = carried.note
      return (
        <Box flexDirection="column">
          <Text>交接摘要已准备好</Text>
          {canAct ? (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button
                key="note-fill"
                label="放进输入框"
                variant="primary"
                onPress={() => later($, 'note-fill', () => fillNote($, text))}
              />
              <Button key="note-send" label="直接发送" onPress={() => later($, 'note-send', () => sendNote($, text))} />
              <Button
                key="note-drop"
                label="丢弃"
                onPress={() => update($, handoff, () => IDLE)}
              />
            </Box>
          ) : null}
        </Box>
      )
    }
    if (carried.stage === 'confirming') {
      return (
        <Box flexDirection="column">
          <Text>Claude 会先写一份交接摘要，再清空对话，然后把摘要放进输入框，你看过再发送。</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="handoff-yes"
              label="开始"
              variant="primary"
              onPress={() => later($, 'handoff', () => startHandoff($))}
            />
            <Button
              key="handoff-no"
              label="取消"
              onPress={() => update($, handoff, () => IDLE)}
            />
          </Box>
        </Box>
      )
    }

    const line = showUsage
      ? usageLine(await read($, spend), await read($, quota), e.props.isWorking)
      : null
    const usage = line === null ? null : <Text dimColor>{line}</Text>

    const fill = await read($, ctx)
    const tokens = fill?.tokens ?? null
    if (tokens === null) {
      const compacted =
        showMeter && fill?.isCompacted ? <Text dimColor>已压缩 · 下一轮结束后显示上下文大小</Text> : null
      if (compacted === null && usage === null) return next(e)
      return (
        <Box flexDirection="column">
          {compacted}
          {usage}
        </Box>
      )
    }

    const given = await read($, advice)
    const hidden = await read($, isHidden)
    const meter = `上下文 ${wan(tokens)} / ${wan(fill?.window ?? 0)}`
    const isOver = tokens >= threshold

    if ((!isOver && given === null) || hidden) {
      const quiet = showMeter ? <Text dimColor>{`${meter} · ${wan(threshold)} 时提醒`}</Text> : null
      if (quiet === null && usage === null) return next(e)
      return (
        <Box flexDirection="column">
          {quiet}
          {usage}
        </Box>
      )
    }

    if (await read($, isConfirmingClear)) {
      return (
        <Box flexDirection="column">
          <Text>清空当前对话、开始新对话？之前的内容不会再发给 Claude。</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key="clear-yes"
              label="确认，开新对话"
              variant="primary"
              onPress={() => later($, 'clear', () => clearNow($))}
            />
            <Button
              key="clear-no"
              label="取消"
              onPress={() => update($, isConfirmingClear, () => false)}
            />
          </Box>
        </Box>
      )
    }

    let headline = `${meter} · 已超过 ${wan(threshold)}`
    let primary: 'compact' | 'new_session' | null = null
    if (given?.verdict === 'wait') {
      headline = `${meter} · 任务还没完成，做完后再压缩`
    } else if (given?.verdict === 'compact') {
      headline = `建议压缩 · ${meter}`
      primary = 'compact'
    } else if (given?.verdict === 'new_session') {
      headline = `建议开新对话 · ${meter}`
      primary = 'new_session'
    }

    const drawn = `band on ${e.surface}: ${headline}${canAct ? ' [buttons]' : ''}`
    if (drawn !== lastDrawn) {
      lastDrawn = drawn
      log($, drawn)
    }

    const focus = given?.focus ?? ''
    const compactButton = (
      <Button
        key="compact"
        label="压缩"
        variant={primary === 'compact' ? 'primary' : 'secondary'}
        onPress={() => later($, 'compact', () => compactNow($, focus))}
      />
    )
    const handoffButton = (
      <Button
        key="handoff"
        label="带摘要开新对话"
        onPress={() => update($, handoff, () => ({ stage: 'confirming', note: '' }))}
      />
    )
    const newButton = (
      <Button
        key="new"
        label="新对话"
        variant={primary === 'new_session' ? 'primary' : 'secondary'}
        onPress={() => update($, isConfirmingClear, () => true)}
      />
    )

    return (
      <Box flexDirection="column">
        <Text bold={primary !== null}>{headline}</Text>
        {given !== null && given.reason !== '' ? <Text dimColor>{given.reason}</Text> : null}
        {usage}
        {canAct ? (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {primary === 'new_session'
              ? [newButton, handoffButton, compactButton]
              : [compactButton, handoffButton, newButton]}
            <Button key="hide" label="隐藏" onPress={() => update($, isHidden, () => true)} />
          </Box>
        ) : null}
      </Box>
    )
  })
}
