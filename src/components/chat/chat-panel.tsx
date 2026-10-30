import { useEffect, useRef, useState } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, validateUIMessages } from "ai"
import { z } from "zod"
import { Brain, Code2, Download, FileSpreadsheet, History, Loader2, MessageSquare, MessageSquareText, Paperclip, Send, Square, Table2, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Markdown } from "@/components/chat/markdown"
import { ProposalCard, type ProposalActions } from "@/components/chat/proposal-card"
import { LocationSearchStatus, type LocationSearch } from "@/components/convert/location-panel"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from "@/components/ui/message-scroller"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import type { TableView } from "@/lib/cases/view"
import { chatDataSchemas, chatMetadataSchema, conversationUsd, type ChatAction, type ChatMessage, type ChatRequest } from "@/lib/chat/messages"
import type { MappingPlan } from "@/lib/convert/plan"
import type { KojiFieldId } from "@/lib/spec/koji-keireki"
import type { ChatChange, Proposal } from "@/lib/chat/proposals"
import { Cost } from "@/components/cost"
import type { UsdJpy } from "@/lib/fx"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { ATTACH_ACCEPT } from "@/lib/cases/types"
import { endChatFn, stopChatFn } from "@/server/chat-fns"

const historySchema = z.object({ messages: z.array(z.unknown()), carryover: z.boolean() })

/** 保存した会話を読み、形を確かめる（サーバーの R2 の会話。変更案の部品は id だけ）。carried はこの会話で去年のコードを添えたか */
async function loadHistory(caseId: string): Promise<{ messages: ChatMessage[]; carried: boolean }> {
  const res = await fetch(`/api/cases/${caseId}/chat`)
  if (!res.ok) throw new Error((await res.text()) || "会話を読めませんでした")
  const history = historySchema.parse(await res.json())
  // validateUIMessages は空の並びを受け付けない
  const messages = history.messages.length
    ? await validateUIMessages<ChatMessage>({
        messages: history.messages,
        metadataSchema: chatMetadataSchema.optional(),
        dataSchemas: { proposal: chatDataSchemas.proposal, carryover: chatDataSchemas.carryover, "location-offer": chatDataSchemas["location-offer"], action: chatDataSchemas.action },
      })
    : []
  return { messages, carried: history.carryover }
}

/** 「去年のやり方で直す」で送る指示 */
const CARRYOVER_TEXT = "顧客ルールどおりに表を直して"

/** コードから呼ぶ道具の、画面での呼び名 */
const TOOL_LABELS: Record<string, string> = {
  get_table: "表を読む",
  check_table: "検査を確かめる",
  set_cells: "セルの変更案",
  set_include: "載せる・外すの変更案",
  add_rows: "工事を足す変更案",
  ask_customer: "問い合わせの変更案",
  set_selection: "7割の設定の変更案",
  set_plan: "列の対応の変更案",
  offer_action: "ボタンを出す",
  ask_staff: "聞き返し",
  propose_rule: "ルールの項目の案",
  get_review: "今年の作業を振り返る",
  propose_review: "顧客ルールの案（振り返り）",
  find_location: "工事場所を調べる",
  get_inquiries: "問い合わせを読む",
  record_answers: "顧客の回答の変更案",
  propose_inquiry: "問い合わせの文面の案",
}

export type ChatPanelProps = {
  caseId: string
  /** 見せているか（閉じても消さずに隠す。進めている指示と会話の状態を残す） */
  open: boolean
  /** 変換が済んで送れるか */
  ready: boolean
  /** 送る直前に今の表と文脈を作る（送るまでの手直しも入れる。大きいので送るときだけ呼ぶ） */
  request: () => Omit<ChatRequest, "id" | "text"> | null
  proposals: readonly Proposal[]
  /** 開いている変更案の中身 */
  changes: ReadonlyMap<string, readonly ChatChange[]>
  view: TableView | null
  actions: Omit<ProposalActions, "canSend">
  busy: boolean
  /** ドル円（取れなければ null で、円は出さない） */
  fx: UsdJpy | null
  /**
   * 同じ顧客の前の年度の案件があれば「去年のやり方で直す」を出す。ready は去年との違いを文脈に入れられるようになったか
   * （去年の Excel を読み終えた）、names は去年の Excel の配置技術者（去年のコードから個人名を消す）、headers は去年と今年の見出し（伏せない語）
   */
  carryover: { fiscalYear: number; ready: boolean; names: () => string[]; headers: () => string[] } | null
  onProposal: (p: { proposal: Proposal; changes: ChatChange[] }) => void
  onCaseCost: (usd: number) => void
  onClose: () => void
  /** 工事場所の一括調査（返事の「調べ始める」は案件の画面と同じものを動かす） */
  location: LocationSearch
  /** 会話の最初に出す変換の報告（案件の作業から作る。保存しない） */
  report: React.ReactNode
  /** チャット欄に落とした・付けたファイル（種類は案件の画面が見分ける） */
  onFiles: (files: File[]) => void
  /** 返事のボタン（書き出す前の確認・問い合わせ・編集用の Excel） */
  onAction: (action: ChatAction) => void
  /** 今の列の対応（列の対応の変更案を「今 → 案」で出す） */
  plan: MappingPlan<KojiFieldId> | null
  /** 狭い画面で、閉じるボタンを出すか（広い画面ではチャットは閉じない） */
  closable: boolean
  /**
   * AI に頼むとよいこと（返ってきた記入用Excelの、決まった欄で読めなかった記入〔ファイルごと。fileName はそのファイル〕と、案件を完了にしたときの振り返り）。
   * 押すと prompt を送り、送れたら onSuggestionSent。会話の最後に出す
   */
  suggestions: readonly Suggestion[]
  onSuggestionSent: (id: string) => void
  /**
   * 送る前に作業を保存し終える（サーバーが保存した作業を読む道具のため。例: 振り返り）。保存できなければ false。
   * 保存の要る案内（needsSaved）は false なら送らない。ほかの指示は保存できなくても送る（表は画面が送る）
   */
  beforeSend: () => Promise<boolean>
}

/** チャットの案内。needsSaved は送る前に作業を保存し終える要るもの、once は会話に同じ指示があればもう出さないもの */
export type Suggestion = { id: string; fileName?: string; text: string; label: string; prompt: string; needsSaved?: true; once?: true }

/**
 * 案件の画面の横のチャット。AI の変更は変更案として返事に付け、職員が承認したものだけを表に入れる。
 * 会話は案件に保存し（R2）、開き直すと続きから。「会話を終える」で AI に渡したファイルを消す
 */
export function ChatPanel(props: ChatPanelProps) {
  const { caseId, open, proposals, changes, view, actions, busy, fx, carryover, onClose, closable } = props
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState("")
  const [ending, setEnding] = useState(false)
  const live = useRef(props)
  live.current = props
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** 送った指示がサーバーに断られたか（send が回答済みにしてよいかを決める） */
  const failed = useRef(false)

  const { messages, sendMessage, status, error, setMessages, stop } = useChat<ChatMessage>({
    id: caseId,
    transport: new DefaultChatTransport({
      api: `/api/cases/${caseId}/chat`,
      prepareSendMessagesRequest: ({ messages, body: options }) => {
        const last = messages.at(-1)!
        const text = last.parts.map((p) => (p.type === "text" ? p.text : "")).join("")
        const body: ChatRequest = { id: last.id, text, ...live.current.request()!, ...(options?.carryover === true ? { carryover: true, carryoverNames: live.current.carryover?.names() ?? [], carryoverHeaders: live.current.carryover?.headers() ?? [] } : {}) }
        return { body }
      },
    }),
    onData: (part) => {
      if (part.type === "data-proposal-content") live.current.onProposal(part.data)
    },
    onFinish: ({ message }) => {
      if (message.metadata) live.current.onCaseCost(message.metadata.caseUsd)
      // 去年のコードを添えたかはサーバーの会話の記録の印に従う（止めた・失敗した回は添えたことにならない）
      if (message.metadata?.carryover !== undefined) setCarried(message.metadata.carryover)
    },
    onError: () => {
      failed.current = true
    },
  })
  const working = status === "submitted" || status === "streaming"
  /** 保存した会話。読み終えるまで送れない */
  const [history, setHistory] = useState<"loading" | "loaded" | { error: string }>("loading")
  /** この会話で去年のコードを添えたか（サーバーの会話の記録の印。会話を読んだとき・返事のたびに受け取る） */
  const [carried, setCarried] = useState(false)
  useEffect(() => {
    let live = true
    void loadHistory(caseId).then(
      (h) => {
        if (!live) return
        setMessages(h.messages)
        setCarried(h.carried)
        setHistory("loaded")
      },
      (e) => live && setHistory({ error: errorMessage(e, "会話を読めませんでした") }),
    )
    return () => {
      live = false
    }
    // 読むのは開いたときの1回だけ（あとは指示の返事で会話が進む）
  }, [caseId])
  const ready = props.ready && history === "loaded"

  /** 送る。送れなかった（返事の途中・会話の読み込み中、またはサーバーが断った）なら false */
  /** keepInput なら入力欄の書きかけを残す（決まった指示を送るボタン） */
  /** 送る前の保存を待っている間（続けて押しても二度送らない） */
  const [preparing, setPreparing] = useState(false)
  async function send(text = input.trim(), options: { carryover?: true; keepInput?: true; needsSaved?: true } = {}) {
    if (!text || working || preparing || !ready) return false
    setPreparing(true)
    let saved: boolean
    try {
      saved = await live.current.beforeSend()
    } finally {
      setPreparing(false)
    }
    if (!saved && options.needsSaved) {
      toast.error("作業を保存できていないので送りませんでした（保存の状態を確かめてから、もう一度押してください）")
      return false
    }
    if (!options.carryover && !options.keepInput) setInput("")
    failed.current = false
    await sendMessage({ text }, options.carryover ? { body: { carryover: true } } : undefined)
    return !failed.current
  }
  /** 会話にもう送った指示（once の案内を出さない） */
  const sentTexts = new Set(messages.flatMap((m) => (m.role === "user" ? [m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")] : [])))

  /** 画面の流れを止め、サーバーにも止めるよう伝える（流れを切るだけでは AI の呼び出しが止まらないことがある） */
  function stopTurn() {
    const turnId = [...messages].reverse().find((m) => m.role === "user")?.id
    void stop()
    if (turnId) void stopChatFn({ data: { caseId, turnId } }).catch((e) => toast.error(errorMessage(e, "止められませんでした")))
  }

  async function end() {
    setEnding(true)
    try {
      const ended = await endChatFn({ data: { caseId } })
      if (ended) {
        setMessages((ms) => [...ms, { id: ended.id, role: "system", parts: [{ type: "text", text: ended.text }] }])
        // 会話を終えるとサーバーは会話の記録を捨てる（印も無くなる）
        setCarried(false)
      }
    } catch (e) {
      toast.error(errorMessage(e, "会話を終えられませんでした"))
    } finally {
      setEnding(false)
    }
  }

  const byId = new Map(proposals.map((p) => [p.id, p]))
  const proposalActions: ProposalActions = {
    decide: actions.decide,
    // 変更案の無い聞き返しは、答えを AI に送って続けさせる（送れたときだけ回答済みにする。送れない間は答えるボタンを押せない）。
    // 変更案があれば「はい」で承認できるようになるだけ
    answer: (id, a) => {
      const p = byId.get(id)
      if (!p || p.state !== "open") return
      if (p.count > 0) {
        actions.answer(id, a)
        if (a === "no") inputRef.current?.focus()
        return
      }
      void send(a === "yes" ? "はい" : "いいえ").then((sent) => sent && actions.answer(id, a))
    },
    canSend: ready && !working,
    undo: actions.undo,
    undoState: actions.undoState,
  }
  const total = conversationUsd(messages)

  return (
    <aside
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-[var(--aside-width)] max-w-full flex-col border-l bg-background shadow-xl xl:top-14 xl:z-20 xl:shadow-none",
        !open && "hidden",
        dragging && "ring-2 ring-violet-400 ring-inset",
      )}
      data-testid="chat-panel"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length) props.onFiles([...e.dataTransfer.files])
      }}
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <MessageSquare className="size-4 text-violet-600" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">チャット</div>
          <div className="text-xs text-muted-foreground" data-testid="chat-cost">
            この会話の AI の費用 <Cost usd={total} fx={fx} />
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={end} disabled={working || ending} title="AI に渡したファイルを消し、次の指示から新しい会話にします" data-testid="chat-end">
          {ending ? <Loader2 className="animate-spin" /> : <Trash2 />}
          会話を終える
        </Button>
        {closable && (
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="チャットを閉じる">
            <X />
          </Button>
        )}
      </header>

      <MessageScrollerProvider autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-4 px-4 py-3" data-testid="chat-messages">
              {props.report}
              {carryover && history === "loaded" && !carried && (
                <div className="grid gap-2 rounded-lg border bg-violet-50/60 px-3 py-2 text-xs dark:bg-violet-950/30" data-testid="chat-carryover">
                  <span className="text-muted-foreground">
                    {carryover.fiscalYear}年度の案件があります。顧客ルールと去年承認したコードを添えて直します。
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-fit"
                    disabled={!ready || working || !carryover.ready}
                    title={carryover.ready ? undefined : "去年の Excel を読んでいます"}
                    onClick={() => void send(CARRYOVER_TEXT, { carryover: true })}
                    data-testid="chat-carryover-send"
                  >
                    <History /> 去年のやり方で直す
                  </Button>
                </div>
              )}
              {history === "loading" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> 会話を読んでいます…
                </div>
              )}
              {typeof history === "object" && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800" data-testid="chat-error">
                  {history.error}
                </div>
              )}
              {history === "loaded" && messages.length === 0 && props.ready && (
                <p className="text-xs text-muted-foreground">例:「金額は税込の列で」「完成年月は引渡日にして」「CSV を出して」</p>
              )}
              {messages.map((m, i) => (
                <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "user"}>
                  <ChatMessageView
                    message={m}
                    streaming={working && i === messages.length - 1 && m.role === "assistant"}
                    proposals={byId}
                    changes={changes}
                    view={view}
                    actions={proposalActions}
                    busy={busy}
                    fx={fx}
                    location={props.location}
                    onAction={props.onAction}
                    plan={props.plan}
                  />
                </MessageScrollerItem>
              ))}
              {status === "submitted" && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="chat-working">
                  <Loader2 className="size-3.5 animate-spin" /> AI が作業しています…
                </div>
              )}
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800" data-testid="chat-error">
                  {error.message}
                </div>
              )}
              {history === "loaded" &&
                props.suggestions.filter((sg) => !(sg.once && sentTexts.has(sg.prompt))).map((sg) => (
                  <div key={sg.id} className="grid gap-2 rounded-lg border bg-violet-50/60 px-3 py-2 text-xs dark:bg-violet-950/30" data-testid="chat-suggestion" data-suggestion={sg.id} data-file-name={sg.fileName}>
                    <span className="text-muted-foreground">{sg.text}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-fit"
                      disabled={!ready || working || preparing}
                      onClick={() => void send(sg.prompt, { keepInput: true, ...(sg.needsSaved ? { needsSaved: true } : {}) }).then((sent) => sent && live.current.onSuggestionSent(sg.id))}
                      data-testid="chat-suggestion-send"
                    >
                      <MessageSquareText /> {sg.label}
                    </Button>
                  </div>
                ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <InputGroup>
          <InputGroupTextarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={ready ? "指示（⌘+Enter で送る）" : "ファイルを落とすと変換します"}
            disabled={!ready}
            className="min-h-16 text-sm"
            data-testid="chat-input"
          />
          <InputGroupAddon align="block-end" className="justify-between">
            <InputGroupButton size="icon-xs" variant="ghost" onClick={() => fileInput.current?.click()} aria-label="ファイルを付ける" title="ファイルを付ける">
              <Paperclip />
            </InputGroupButton>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              className="sr-only"
              data-testid="chat-file-input"
              onChange={(e) => {
                if (e.target.files?.length) props.onFiles([...e.target.files])
                e.target.value = ""
              }}
            />
            {working ? (
              <InputGroupButton size="icon-xs" variant="outline" onClick={stopTurn} aria-label="止める" data-testid="chat-stop">
                <Square />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" size="icon-xs" variant="default" disabled={!input.trim() || !ready} aria-label="送る" data-testid="chat-send">
                <Send />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </aside>
  )
}

function ChatMessageView({
  message,
  streaming,
  proposals,
  changes,
  view,
  actions,
  busy,
  fx,
  location,
  onAction,
  plan,
}: {
  message: ChatMessage
  location: LocationSearch
  onAction: (a: ChatAction) => void
  plan: MappingPlan<KojiFieldId> | null
  streaming: boolean
  proposals: ReadonlyMap<string, Proposal>
  changes: ReadonlyMap<string, readonly ChatChange[]>
  view: TableView | null
  actions: ProposalActions
  busy: boolean
  fx: UsdJpy | null
}) {
  if (message.role === "system")
    return <p className="border-y py-1.5 text-center text-xs text-muted-foreground">{message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</p>
  if (message.role === "user")
    return (
      <Message align="end">
        <MessageContent>
          <Bubble variant="muted" align="end">
            <BubbleContent className="whitespace-pre-wrap">{message.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  const meta = message.metadata
  return (
    <Message data-testid="chat-assistant">
      <MessageContent>
        {message.parts.map((p, i) => {
          if (p.type === "text") return <Markdown key={i} text={p.text} streaming={streaming} />
          if (p.type === "reasoning")
            return p.text ? (
              <Step key={i} icon={<Brain />} title="考えたこと">
                <div className="text-xs whitespace-pre-wrap text-muted-foreground">{p.text}</div>
              </Step>
            ) : null
          // 去年のコードを添えた印は、その返事で会話の記録に添えた印が立ったときだけ出す（止めた・失敗した返事の部品は出さない。同じ印を2回描かない）
          if (p.type === "data-carryover" && meta?.carryover === true)
            return (
              <p key={i} className="text-xs text-muted-foreground" data-testid="chat-carryover-note">
                {p.data.skipped
                  ? `${p.data.skipped}。顧客ルールだけで直します。`
                  : p.data.codes
                    ? `${p.data.fiscalYear}年度の案件で承認につながったコード ${p.data.codes} 件と、顧客ルールを添えました。`
                    : `${p.data.fiscalYear}年度の案件に承認につながったコードは無かったので、顧客ルールだけで直します。`}
              </p>
            )
          if (p.type === "data-location-offer")
            return (
              <div key={i} className="rounded-lg border bg-muted/20 p-2" data-testid="chat-location-offer">
                <LocationSearchStatus search={location} fx={fx} testId="chat-location" />
              </div>
            )
          if (p.type === "data-proposal") return <ProposalCard key={i} proposal={proposals.get(p.data.id)} changes={changes.get(p.data.id)} view={view} actions={actions} busy={busy} plan={plan} />
          if (p.type === "data-action") return <ActionButton key={i} action={p.data.action} onAction={onAction} />
          if (p.type.startsWith("tool-")) {
            const name = p.type.slice(5)
            const input = (p as { input?: { code?: string } }).input
            if (name === "code_execution")
              return (
                <Step key={i} icon={<Code2 />} title="コードを実行">
                  <CodeBlock size="sm">
                    <CodeBlockContent wrap className="max-h-64 text-[11px]">
                      {input?.code ?? JSON.stringify(input, null, 1) ?? ""}
                    </CodeBlockContent>
                  </CodeBlock>
                </Step>
              )
            return (
              <Trace key={i}>
                <TraceLine>
                  <TraceIcon>
                    <Table2 />
                  </TraceIcon>
                  <TraceTitle className="text-xs text-muted-foreground">{TOOL_LABELS[name] ?? name}</TraceTitle>
                </TraceLine>
              </Trace>
            )
          }
          return null
        })}
        {meta && (
          <MessageFooter className="px-0" data-testid="chat-reply-cost">
            {Math.round(meta.ms / 1000)}秒・道具 {meta.toolCalls} 回・<Cost usd={meta.usd} fx={fx} />
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  )
}

const ACTION_BUTTONS = {
  export: { label: "書き出す前の確認を開く", icon: <FileSpreadsheet /> },
  inquiry_excel: { label: "顧客への問い合わせを開く", icon: <MessageSquareText /> },
  edit_excel: { label: "編集用の Excel を落とす", icon: <Download /> },
} satisfies Record<ChatAction, { label: string; icon: React.ReactNode }>

function ActionButton({ action, onAction }: { action: ChatAction; onAction: (a: ChatAction) => void }) {
  const b = ACTION_BUTTONS[action]
  return (
    <Button size="sm" variant="outline" className="w-fit" onClick={() => onAction(action)} data-testid="chat-action" data-action={action}>
      {b.icon} {b.label}
    </Button>
  )
}

function Step({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>{icon}</TraceIcon>
            <TraceTitle className="text-xs">{title}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
