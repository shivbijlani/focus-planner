// Measure the REAL digest against the LIVE journals by driving the actual
// createBridge()/syncDigest() code path with a fake Telegram client, so nothing
// is sent and no state is written. This exercises shipped code, not a
// reimplementation of it.
const ROOT = process.env.BRIDGE_SRC
const { createBridge } = await import(`${ROOT}/bridge.js`)
const { emptyState } = await import(`${ROOT}/state.js`)
const { createFsIo } = await import(`${ROOT}/io.js`)

const planner = process.env.PLANNER_PATH
const io = createFsIo({
  journalDir: `${planner}\\journal`,
  boardPath: `${planner}\\planner.md`,
  completedBoardPath: `${planner}\\planner-completed.md`,
})

const sent = []
const client = {
  async sendMessage(m) { sent.push(m) },
  async createForumTopic({ name }) { return { message_thread_id: 999, name } },
  async getMe() { return { username: 'bench', id: 1 } },
  async getChatMember() { return { status: 'administrator' } },
  async getUpdates() { return [] },
}

const bridge = createBridge({
  client,
  config: { chatId: '-100', taskAllowlist: [] },
  state: emptyState(),
  io,
  logger: () => {},
})

const res = await bridge.syncDigest()
const text = sent[0]?.text ?? ''

// Parse ONE id per digest entry line, anchored to the bullet buildDigest()
// emits: `• **#<taskId> · <title>** — <ask>`.
//
// A global /#(\d+)/g scrape over the whole message is WRONG and silently
// over-reports: the ask text routinely quotes PR numbers (`merge 163`,
// `#154/#156/#157/#158/#160/#161/#162`), and every one of those was being
// counted as a visible task. Measured 2026-08-23: 25 "visible" of which 8
// (150/154/156/157/158/160/161/162) were PR references with no board row and
// no journal — they inflated the count by ~47% and shifted every slot number,
// which is the number this harness exists to report.
const visible = text
  .split('\n')
  .map((line) => /^\u2022 (?:<b>|\*\*)#(\d+)\b/.exec(line))
  .filter(Boolean)
  .map((m) => m[1])
const uniq = [...new Set(visible)]

// The compact second tier names the overflow as bare `#id` tokens on a single
// labelled line. Those tasks ARE visible to the user — just without their ask
// text — so a harness that only counted detailed bullets would under-report
// coverage exactly as badly as the old global scrape over-reported it.
const rollupLine = text
  .split('\n')
  .find((line) => /^(?:<b>Also waiting:<\/b>|\*\*Also waiting:\*\*)/.test(line))
const rollup = rollupLine
  ? [...rollupLine.matchAll(/#(\d+)\b/g)].map((m) => m[1])
  : []
const rollupUniq = [...new Set(rollup)].filter((id) => !uniq.includes(id))
const named = [...uniq, ...rollupUniq]

const dropped = /\u2026and (\d+) more/.exec(text)

console.log(`open asks   : ${res.count}`)
console.log(`detailed    : ${uniq.length} -> ${uniq.join(' ')}`)
console.log(`roll-up     : ${rollupUniq.length}`)
console.log(`named total : ${named.length} of ${res.count}`)
console.log(`message len : ${text.length} (Telegram cap 4096)`)
if (dropped) console.log(`unnamed     : ${dropped[1]} (message hit the size cap)`)
for (const w of (process.argv.slice(2))) {
  const i = named.indexOf(w)
  const tier = i === -1 ? 'ABSENT' : i < uniq.length ? `slot ${i + 1} (detailed)` : 'roll-up'
  console.log(`  #${w}: ${tier}`)
}
