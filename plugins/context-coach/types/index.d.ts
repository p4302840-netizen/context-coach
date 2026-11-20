/**
 * The live context fill, as the last measurement reported it. After a
 * compaction `tokens` is null and `isCompacted` set until the next turn is
 * measured: core's own count then leaves out the system prompt and tools
 * (about 65k on the desktop app), so it would read far too low.
 */
export type Ctx = { tokens: number | null; window: number; isCompacted?: boolean }

/**
 * The tokens this conversation's requests used, as the API reported each
 * (subagents' and compactions' included), counted since it opened or was
 * last cleared. `weighted` prices every request in plain input tokens:
 * cache reads at 0.1, cache writes at 1.25 (five minutes) or 2 (an hour),
 * output at 5. `turnWeighted` is the latest main-thread turn's part of it.
 */
export type Spend = {
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  weighted: number
  turnId: string
  turnWeighted: number
}

/**
 * The main thread's prompt cache: it lapses `ttlMs` after the last request
 * read or wrote it (the lifetime the request's writes named). `isCold` once
 * that time passed; `isDismissed` when the person waved the warning off.
 */
export type Cache = { coldAt: number; ttlMs: number; isCold: boolean; isDismissed: boolean }

/** One of the account's rate-limit windows: `five_hour`, `seven_day`, … */
export type Quota = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * What the context window holds, as /context breaks it down: its rows
 * (largest first) and the three connectors whose tools take the most.
 * `isFailed` when the breakdown could not be read.
 */
export type Details = {
  total: number
  rows: { name: string; tokens: number }[]
  servers: { name: string; tokens: number }[]
  isFailed: boolean
}

/** All conversations' use on one local day, input-priced (Spend's `weighted`). */
export type Today = { date: string; weighted: number }

/** What Claude judged at the end of a turn past the threshold. */
export type Verdict = 'wait' | 'compact' | 'new_session'

export type Advice = {
  verdict: Verdict
  /** One short sentence for the person, in their language. */
  reason: string
  /** What a compaction's summary must keep; empty when none given. */
  focus: string
  /** Context tokens when the advice was given. */
  at: number
}

/**
 * A new conversation carried over by a handoff note: `confirming` asks the
 * person, `writing` waits for Claude's note, `ready` holds it until the turn
 * ends, `pending` holds it until it is in the new conversation's prompt box.
 */
export type Handoff = {
  stage: 'idle' | 'confirming' | 'writing' | 'ready' | 'pending'
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'context-coach': {
      ctx: Shaped<Ctx | null>
      advice: Shaped<Advice | null>
      handoff: Shaped<Handoff>
      spend: Shaped<Spend>
      quota: Shaped<Quota[]>
      cache: Shaped<Cache | null>
      details: Shaped<Details | null>
      costUsd: number | null
      isDetailsOpen: boolean
      today: Shaped<Today | null>
      title: string
      quietUntil: number
      isHidden: boolean
      isConfirmingClear: boolean
      isBusy: boolean
    }
  }
}
