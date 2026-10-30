/**
 * 1回の指示の後始末の順番。どれかが失敗しても、後のものを飛ばさない:
 * 1. 止める印などの片付け（失敗しても記録には関わらないので、失敗は知らせるだけ）
 * 2. 会話の履歴と作ったファイルの記録（印は立てたまま。印を引き継がれていたら書けない）
 * 3. 費用を案件の合計に足す（D1。失敗しても履歴は書いてある）
 * 返す ours は、印がまだ自分のもの（画面の会話を書いて下ろしてよい）か。error は知らせる失敗（いちばん先のもの）
 */
export async function closeTurn<T>(steps: {
  cleanup: () => Promise<void>
  record: () => Promise<T | null>
  addCost: () => Promise<void>
}): Promise<{ recorded: T | null; ours: boolean; error: unknown }> {
  let error: unknown = null
  const note = (e: unknown) => {
    error ??= e
  }
  await steps.cleanup().catch(note)
  let recorded: T | null = null
  let ours = true
  try {
    recorded = await steps.record()
    ours = recorded !== null
  } catch (e) {
    note(e)
  }
  await steps.addCost().catch(note)
  return { recorded, ours, error }
}

/**
 * 止める印を見張る。前の見張りが終わってから次を見る（重ならない）。見に行けなかった回は次の回でまた見る。
 * stop() で見張りをやめる
 */
export function watchStop(check: () => Promise<boolean>, onStop: () => void, intervalMs: number) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    if (stopped) return
    const hit = await check().catch(() => false)
    if (stopped) return
    if (hit) onStop()
    else timer = setTimeout(tick, intervalMs)
  }
  timer = setTimeout(tick, intervalMs)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/**
 * 変更案の出る指示の終わり。変更案と履歴が食い違わないように:
 * 1. 変更案を R2 に置く（案件の変更案の記録。画面が受け取ったかに依らず、開き直すと案件の作業に入る）。置けなければ、
 *    回は終わらなかったものとして履歴に足さない（AI が出したつもりの変更案が残らない）
 * 2. 後始末（closeTurn。record に、履歴に足してよいかを渡す）
 * 3. 履歴を書けなかったら、置いた変更案を消す。消せなかったら変更案は残っているので、画面にも出す（開き直したときと同じに見せる）
 * 返す proposal は画面に出す変更案があるか
 */
export async function finishTurn<T>(steps: {
  putProposal: (() => Promise<void>) | null
  deleteProposal: () => Promise<void>
  cleanup: () => Promise<void>
  record: (completed: boolean) => Promise<T | null>
  addCost: () => Promise<void>
}): Promise<{ recorded: T | null; ours: boolean; proposal: boolean; error: unknown }> {
  let error: unknown = null
  let proposal = false
  let completed = true
  if (steps.putProposal) {
    try {
      await steps.putProposal()
      proposal = true
    } catch (e) {
      error = e
      completed = false
    }
  }
  const closed = await closeTurn({ cleanup: steps.cleanup, record: () => steps.record(completed), addCost: steps.addCost })
  error ??= closed.error
  if (proposal && closed.recorded === null) {
    try {
      await steps.deleteProposal()
      proposal = false
    } catch (e) {
      error ??= e
    }
  }
  return { recorded: closed.recorded, ours: closed.ours, proposal, error }
}
