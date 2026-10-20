import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { REACTION_EMOJIS, TERMINAL_TASK_STATES, type AgentSummary, type DomainRequestView, type OwnerRequest, type ReactionEmoji, type Task } from "@quokkabot/shared";
import { askedLine, chatItems, listSites, liveTask, messageReactions, sitesLine, timeLabel, workingStatus, type StepLine } from "@quokkabot/client";
import { IMAGE_ACCEPT, ImageChips, OwnerImages, useChatImages } from "./chat-images.js";
import { AiConsentCard, aiConsentOf, needsAiConsent } from "./ai-consent.js";
import { api } from "./api.js";
import { AgentAvatar } from "./avatar.js";
import { ClaudeSignInCard } from "./claude-sign-in.js";
import { DownloadLink } from "./download-link.js";
import { Markdown } from "./markdown.js";
import { DomainRequestCard, RequestCard } from "./requests.js";
import { useTaskStream } from "./task-stream.js";
import { ErrorLine, bytesLabel, stateLabel, useAction, usePollInterval } from "./ui.js";

// One agent's chat: earlier tasks as short exchanges, the current task in full, and the composer.

function Steps({ lines }: { lines: StepLine[] }) {
  const [open, setOpen] = useState(false);
  const tools = lines.filter(line => line.kind === "tool").length;
  return <div className="steps">
    <button type="button" className="steps-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {tools === 1 ? "1 step" : `${tools} steps`} {open ? "▴" : "▾"}
    </button>
    {open && <ol className="steps-list">{lines.map((line, index) => <li key={index} className={line.kind === "note" ? "step-note" : undefined}>{line.text}</li>)}</ol>}
  </div>;
}

function Working({ index, status }: { index: number; status: string }) {
  return <div className="working" role="status" aria-label={status}>
    <span className="working-face"><AgentAvatar index={index} size={30} /></span>
    <span className="shimmer">{status}</span>
  </div>;
}

const DIVIDER_GAP_MS = 15 * 60_000;

function TimeDivider({ at }: { at: string }) {
  return <p className="time-divider">{timeLabel(at)}</p>;
}

function ReactionPicker({ taskId, seq, emoji }: { taskId: string; seq: number; emoji: ReactionEmoji | undefined }) {
  const [open, setOpen] = useState(false);
  const controls = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const react = useAction(async (choice: ReactionEmoji) => {
    await api.react(taskId, seq, choice === emoji ? null : choice);
    setOpen(false);
    trigger.current?.focus();
  });
  useEffect(() => {
    if (!open) return;
    picker.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !controls.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", outside); };
  }, [open]);
  return <div ref={controls} className="reaction-controls">
    <button ref={trigger} type="button" className="reaction-trigger" aria-label="React" title="React" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(value => !value)}><span aria-hidden="true">☺</span></button>
    {open && <div ref={picker} className="reaction-picker" role="dialog" aria-label="Choose a reaction">
      {REACTION_EMOJIS.map(choice => <button key={choice} type="button" aria-label={`React ${choice}`} aria-pressed={emoji === choice}
        disabled={react.isPending} onClick={() => react.mutate(choice)}>{choice}</button>)}
    </div>}
    <ErrorLine error={react.error} />
  </div>;
}

function Bubble({ from, children, live = false, reaction, reactTo }: {
  from: "owner" | "agent"; children: ReactNode; live?: boolean;
  reaction?: ReactionEmoji | undefined; reactTo?: { taskId: string; seq: number } | undefined;
}) {
  return <div className={`bubble-row ${from}${reaction ? " has-reaction" : ""}`}><div className={`bubble ${from}`}>
    {children}{live && <span className="typing" aria-label="Writing" />}
    {reactTo && <ReactionPicker taskId={reactTo.taskId} seq={reactTo.seq} emoji={reaction} />}
    {reaction && <span className="reaction-badge" role="img" aria-label={`${from === "agent" ? "Your" : "Agent"} reaction: ${reaction}`}>{reaction}</span>}
  </div></div>;
}

function CurrentTask({ agent, index, task, snapshotSeq, openRequests, earliestAt }: { agent: AgentSummary; index: number; task: Task; snapshotSeq: number; openRequests: OwnerRequest[]; earliestAt: string | null }) {
  const stream = useTaskStream(task.id);
  const interval = usePollInterval();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox, refetchInterval: interval });
  const items = useMemo(() => chatItems(stream.events), [stream.events]);
  const reactions = useMemo(() => messageReactions(stream.events), [stream.events]);
  // The live state: a state event the stream delivered after the task was loaded, else the task as loaded.
  const liveState = liveTask(task, snapshotSeq, stream.events);
  const terminal = TERMINAL_TASK_STATES.has(liveState.state);
  const placedSites = new Set(items.flatMap(item => item.kind === "domain" ? [item.requestId] : []));
  const placedRequests = new Set(items.flatMap(item => item.kind === "request" ? [item.request.id] : []));
  // An open card the stream has not delivered yet, or a request for sites made before they were recorded in the chat,
  // has no place in it: it shows last.
  const unplacedRequests = terminal ? [] : openRequests.filter(request => request.kind !== "question" && !placedRequests.has(request.id));
  const unplacedSites = inbox.data?.items.flatMap(item => item.kind === "domain_request" && item.request.taskId === task.id && !placedSites.has(item.request.id) ? [item.request] : []) ?? [];
  const openSites = items.some(item => item.kind === "domain" && item.decision === null) || unplacedSites.length > 0;
  const busy = !terminal && liveState.blockedReason === null && openRequests.length === 0 && !openSites;
  // While the agent works: its latest line between tools, else what its latest tool does.
  const lastItem = items.at(-1);
  const currentSteps = busy && lastItem?.kind === "steps" ? lastItem.lines : [];
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [items.length, openRequests.length, busy]);
  let lastOwnerAt: string | null = null;
  return <>
    {items.map(item => {
      switch (item.kind) {
        case "owner": {
          const previous = lastOwnerAt;
          lastOwnerAt = item.at;
          const divider = previous === null ? Date.parse(item.at) - Date.parse(earliestAt ?? item.at) > DIVIDER_GAP_MS || earliestAt === null : Date.parse(item.at) - Date.parse(previous) > DIVIDER_GAP_MS;
          return <div key={item.key}>{divider && <TimeDivider at={item.at} />}<Bubble from="owner" reaction={reactions.get(item.seq)?.agent}><OwnerImages attachments={item.attachments} />{item.text && <p className="plain">{item.text}</p>}</Bubble></div>;
        }
        case "agent": return <Bubble key={item.key} from="agent" live={item.live} reaction={item.seq === null ? undefined : reactions.get(item.seq)?.owner}
          reactTo={item.seq === null ? undefined : { taskId: task.id, seq: item.seq }}><Markdown text={item.text} /></Bubble>;
        case "steps": return <Steps key={item.key} lines={item.lines} />;
        case "notice": if (task.error && /signed out/i.test(task.error) && item.text === task.error) return null; return <p key={item.key} className={`notice ${item.tone}`}>{item.text}</p>;
        case "request":
          if (item.request.kind === "question") return <Bubble key={item.key} from="agent" reaction={reactions.get(item.seq)?.owner}
            reactTo={{ taskId: task.id, seq: item.seq }}><Markdown text={item.request.text} /></Bubble>;
          {
            // An open card sits where the agent asked; once answered, skipped or ended it stays there as one line.
            const open = terminal ? undefined : openRequests.find(request => request.id === item.request.id);
            return open ? <RequestCard key={item.key} request={open} agentId={agent.id} /> : <p key={item.key} className="notice info">{askedLine(item.request)}</p>;
          }
        case "domain": {
          if (item.decision === null && !terminal) {
            const request: DomainRequestView = { id: item.requestId, taskId: task.id, domains: item.domains, reason: item.reason, createdAt: item.at, decidedAt: null, decision: null };
            return <DomainRequestCard key={item.key} request={request} />;
          }
          return <p key={item.key} className="notice info">{sitesLine(item.decision, listSites(item.domains))}</p>;
        }
      }
    })}
    {busy && !(items.at(-1)?.kind === "agent" && (items.at(-1) as { live?: boolean }).live) && <Working index={index} status={workingStatus(currentSteps)} />}
    {unplacedRequests.map(request => <RequestCard key={request.id} request={request} agentId={agent.id} />)}
    {unplacedSites.map(request => <DomainRequestCard key={request.id} request={request} />)}
    {task.result && task.result.files.length > 0 && <div className="attachments">{task.result.files.map(file => <div key={file.fileId} className="attachment">
      <span className="attachment-icon" aria-hidden="true">{file.name.split(".").at(-1)?.slice(0, 4).toUpperCase() ?? "FILE"}</span>
      <span className="attachment-text"><strong>{file.name}</strong><span>{bytesLabel(file.bytes)} · {file.scope}</span></span>
      <DownloadLink target={{ fileId: file.fileId }} name="Download" />
    </div>)}</div>}
    {task.error && (/signed out/i.test(task.error)
      ? agent.cliSignedIn === "yes" ? <RetryNotice taskId={task.id} /> : <ClaudeSignInCard key={agent.id} agent={agent} />
      : !items.some(item => item.kind === "notice" && item.text === task.error) && <p className="notice error">{task.error}</p>)}
    <ErrorLine error={stream.error} />
    {Boolean(stream.error) && <button type="button" className="pill" onClick={stream.reconnect}>Reconnect</button>}
    <div ref={end} />
  </>;
}

// The task failed because Claude Code was signed out, and it is signed in now: offer the retry instead of the old error.
function RetryNotice({ taskId }: { taskId: string }) {
  const retry = useAction(() => api.message(taskId, "Try again."));
  return <div className="notice info">
    <p>This failed while Claude Code was signed out. It is signed in now.</p>
    <button type="button" className="pill dark" disabled={retry.isPending} onClick={() => retry.mutate()}>Try again</button>
    <ErrorLine error={retry.error} />
  </div>;
}

function EarlierTask({ task, onOpen, divider }: { task: Task; onOpen: () => void; divider: boolean }) {
  const outcome = task.result?.summary ?? task.error ?? stateLabel(task.state);
  return <div className="earlier">
    {divider && <TimeDivider at={task.createdAt} />}
    <Bubble from="owner"><p className="plain">{task.title}</p></Bubble>
    <Bubble from="agent"><p className="plain">{outcome}</p><button type="button" className="link-button" onClick={onOpen}>Open this task</button></Bubble>
  </div>;
}

// `waiting`: the task has open cards. A message then answers its question and skips every other card.
export function Composer({ agent, task, ready, openQuestion, waiting, startNew, onCreated }: {
  agent: AgentSummary; task: Task | null; ready: boolean; openQuestion: OwnerRequest | null; waiting: boolean; startNew: () => void; onCreated: (task: Task) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const [sendingImages, setSendingImages] = useState(false);
  // One key per message being written: a second Enter while the first send is in flight cannot create a second task.
  const draftKey = useRef(crypto.randomUUID());
  const [params] = useSearchParams();
  const active = task !== null && !TERMINAL_TASK_STATES.has(task.state);
  const running = active && !waiting;
  const draft = useChatImages(agent.id, running || !ready || sendingImages);
  useEffect(() => { if (params.get("new") === "1") input.current?.focus(); }, [params]);
  // Open when a send needs the owner's permission for the AI provider first; the draft stays for the next send.
  const [askConsent, setAskConsent] = useState(false);
  const send = useAction(async () => {
    const message = text.trim();
    if (sending.current || running || !ready || draft.failed || (!message && draft.images.length === 0)) return;
    if (!aiConsentOf(agent).allowed) { setAskConsent(true); return; }
    sending.current = true;
    setSendingImages(true);
    try {
      const attachmentIds = await draft.uploadedIds();
      if (task === null) onCreated(await api.createTask(agent.id, message, draftKey.current, attachmentIds));
      else if (active && waiting) await api.reply(task.id, message, attachmentIds);
      else if (TERMINAL_TASK_STATES.has(task.state)) await api.message(task.id, message, attachmentIds);
      else throw new Error(`${agent.name} is still working on this task.`);
      setText("");
      draft.clear();
      draftKey.current = crypto.randomUUID();
    } catch (error) {
      // Another app withdrew the permission after this page last loaded the agent.
      if (needsAiConsent(error)) { setAskConsent(true); return; }
      throw error;
    } finally { sending.current = false; setSendingImages(false); }
  });
  const stop = useAction(async () => { if (task) await api.cancel(task.id); });
  const placeholder = active && waiting ? (openQuestion?.kind === "question" ? `Answer ${agent.name}` : `Reply to ${agent.name}`) : running ? (task.blockedReason ? `${agent.name} is waiting for you above` : `${agent.name} is working…`) : task === null ? `New task for ${agent.name}` : `Message ${agent.name}`;
  return <form className="composer" data-hold-reload={draft.images.length > 0 ? "" : undefined} onSubmit={event => { event.preventDefault(); if (!send.isPending) send.mutate(); }}>
    {draft.dragging && <div className="chat-drop-overlay">Drop images here</div>}
    {askConsent && <AiConsentCard agent={agent} onClose={() => { setAskConsent(false); input.current?.focus(); }} />}
    <ErrorLine error={send.error ?? stop.error} />
    <ImageChips draft={draft} disabled={send.isPending} />
    <input ref={picker} type="file" className="image-file-input" aria-label="Choose images" accept={IMAGE_ACCEPT} multiple
      onChange={event => { draft.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    <div className="composer-box">
      <button type="button" className="icon-button" title="New task" aria-label="New task" onClick={() => { startNew(); input.current?.focus(); }}>+</button>
      <button type="button" className="icon-button" title="Attach images" aria-label="Attach images" disabled={running || !ready || send.isPending} onClick={() => picker.current?.click()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9" /></svg>
      </button>
      <textarea ref={input} aria-label={task === null ? "New task" : "Message"} rows={1} value={text} placeholder={placeholder} maxLength={20000}
        disabled={running || !ready || send.isPending} onPaste={event => {
          const files = Array.from(event.clipboardData.items).filter(item => item.kind === "file").flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
          if (files.length > 0) { event.preventDefault(); draft.add(files); }
        }} onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!send.isPending) send.mutate(); } }} />
      {running
        ? <button type="button" className="stop-button" disabled={stop.isPending} onClick={() => stop.mutate()}>Stop</button>
        : <button className="send-button" aria-label="Send" disabled={send.isPending || !ready || draft.failed || (!text.trim() && draft.images.length === 0)}>↑</button>}
    </div>
  </form>;
}

export function AgentChat({ agent, index }: { agent: AgentSummary; index: number }) {
  const interval = usePollInterval();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tasks = useQuery({ queryKey: ["agent-tasks", agent.id], queryFn: () => api.tasks(agent.id), refetchInterval: interval });
  const list = tasks.data?.tasks ?? [];
  const wantsNew = params.get("new") === "1";
  const selectedId = wantsNew ? null : params.get("task") ?? list[0]?.id ?? null;
  const detail = useQuery({ queryKey: ["task", selectedId], queryFn: () => api.task(selectedId as string), enabled: selectedId !== null, refetchInterval: interval });
  const current = selectedId === null ? null : detail.data?.task ?? null;
  const position = selectedId === null ? 0 : list.findIndex(task => task.id === selectedId);
  // A new task keeps the latest tasks above it; an open task shows the ones before it.
  const earlier = (selectedId === null ? list : position >= 0 ? list.slice(position + 1) : []).slice(0, 6).reverse();
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: api.inbox, refetchInterval: interval });
  const openRequests = detail.data?.openRequests.filter(request => request.answeredAt === null) ?? [];
  const openSites = inbox.data?.items.some(item => item.kind === "domain_request" && item.request.taskId === selectedId) ?? false;
  // The composer answers the open question; a message skips every other open card.
  const openQuestion = openRequests.find(request => request.kind === "question") ?? openRequests[0] ?? null;
  const open = (taskId: string) => { void navigate(`/agents/${agent.id}?task=${taskId}`); };
  return <div className="chat">
    <div className="chat-scroll">
      <div className="chat-column">
        {tasks.isPending && <p className="notice info">Loading…</p>}
        <ErrorLine error={tasks.error} />
        {list.length === 0 && !tasks.isPending && (agent.cliSignedIn !== "yes" ? <ClaudeSignInCard key={agent.id} agent={agent} /> : <div className="chat-empty"><AgentAvatar index={index} size={72} /><h1>{agent.name}</h1><p>Give {agent.name} a task. It works on its own computer and asks you when it needs something.</p></div>)}
        {earlier.map((task, i) => <EarlierTask key={task.id} task={task} onOpen={() => open(task.id)} divider={i === 0 || Date.parse(task.createdAt) - Date.parse(earlier[i - 1]?.updatedAt ?? task.createdAt) > DIVIDER_GAP_MS} />)}
        {wantsNew && list.length > 0 && <p className="notice info">New task</p>}
        <ErrorLine error={detail.error} />
        {current && detail.data && <CurrentTask key={current.id} agent={agent} index={index} task={current} snapshotSeq={detail.data.lastSeq} openRequests={openRequests} earliestAt={earlier.at(-1)?.updatedAt ?? null} />}
        {position > 0 && <p className="notice info"><Link to={`/agents/${agent.id}`}>Back to the latest task</Link></p>}
      </div>
    </div>
    <div className="chat-column composer-column">
      <Composer key={agent.id} agent={agent} task={current} ready={selectedId === null || current !== null} openQuestion={openQuestion} waiting={openRequests.length > 0 || openSites} startNew={() => { void navigate(`/agents/${agent.id}?new=1`); }} onCreated={task => open(task.id)} />
    </div>
  </div>;
}
