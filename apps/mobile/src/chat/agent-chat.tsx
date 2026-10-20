import { Fragment, useMemo, useRef, useState, type ComponentRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack } from "expo-router";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TERMINAL_TASK_STATES, type AgentsResponse, type AgentSummary, type DomainRequestView, type InboxResponse, type OwnerRequest, type Task } from "@quokkabot/shared";
import { agentNameEdit, askedLine, chatItems, listSites, liveTask, messageReactions, sitesLine, timeLabel, withAgent, workingStatus, type StepLine } from "@quokkabot/client";
import { DomainRequestCard, OpenOnWeb, RequestCard } from "../cards/requests";
import { useSignedIn } from "../session";
import { AgentAvatar, Button, ErrorLine, Notice } from "../ui/kit";
import { colors } from "../ui/theme";
import { Bubble, bubbleStyles } from "./bubble";
import { Composer } from "./composer";
import { Markdown } from "./markdown";
import { bytesLabel } from "./report";
import { useAction } from "./use-action";
import { useTaskStream } from "./use-task-stream";

const DIVIDER_GAP_MS = 15 * 60_000;
const SIGNED_OUT = "Claude is signed out. Sign in from the web or Mac app; every agent uses that sign-in.";

function TimeDivider({ at }: { at: string }) {
  return <Text style={styles.time}>{timeLabel(at)}</Text>;
}

function Steps({ lines }: { lines: StepLine[] }) {
  const [open, setOpen] = useState(false);
  const tools = lines.filter(line => line.kind === "tool").length;
  const label = tools === 1 ? "1 step" : `${tools} steps`;
  return <View style={styles.steps}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(value => !value)} style={styles.stepsToggle}><Text style={styles.meta}>{label} {open ? "▴" : "▾"}</Text></Pressable>
    {open && <View style={styles.stepList}>{lines.map((line, index) => <Text key={index} style={[styles.meta, line.kind === "note" && styles.note]}>{line.text}</Text>)}</View>}
  </View>;
}

function Working({ index, status }: { index: number; status: string }) {
  return <View accessibilityRole="text" accessibilityLabel={status} accessibilityLiveRegion="polite" style={styles.working}>
    <AgentAvatar index={index} size={30} /><Text style={[styles.meta, styles.flex]}>{status}</Text>
  </View>;
}

function EarlierTask({ agentId, task, onOpen, divider }: { agentId: string; task: Task; onOpen: () => void; divider: boolean }) {
  const outcome = task.result?.summary ?? task.error ?? task.state.replaceAll("_", " ");
  return <View>
    {divider && <TimeDivider at={task.createdAt} />}
    <Bubble agentId={agentId} from="owner" text={task.title} taskId={task.id}><Text style={bubbleStyles.ownerText}>{task.title}</Text></Bubble>
    <Bubble agentId={agentId} from="agent" text={outcome} taskId={task.id}>
      <Text style={bubbleStyles.agentText}>{outcome}</Text>
    </Bubble>
    <Button title="Open this task" kind="quiet" onPress={onOpen} />
  </View>;
}

function CurrentTask({ agent, task, openRequests, earliestAt, stream, inbox }: {
  agent: AgentSummary; task: Task; openRequests: OwnerRequest[]; earliestAt: string | null;
  stream: ReturnType<typeof useTaskStream>; inbox: InboxResponse | undefined;
}) {
  const items = useMemo(() => chatItems(stream.events), [stream.events]);
  const reactions = useMemo(() => messageReactions(stream.events), [stream.events]);
  const terminal = TERMINAL_TASK_STATES.has(task.state);
  const placedSites = new Set(items.flatMap(item => item.kind === "domain" ? [item.requestId] : []));
  const placedRequests = new Set(items.flatMap(item => item.kind === "request" ? [item.request.id] : []));
  const unplacedRequests = terminal ? [] : openRequests.filter(request => request.kind !== "question" && !placedRequests.has(request.id));
  const unplacedSites = inbox?.items.flatMap(item => item.kind === "domain_request" && item.request.taskId === task.id && !placedSites.has(item.request.id) ? [item.request] : []) ?? [];
  const openSites = items.some(item => item.kind === "domain" && item.decision === null) || unplacedSites.length > 0;
  const busy = !terminal && task.blockedReason === null && openRequests.length === 0 && !openSites;
  const lastItem = items.at(-1);
  const currentSteps = busy && lastItem?.kind === "steps" ? lastItem.lines : [];
  let lastOwnerAt: string | null = null;
  return <>
    {items.map(item => {
      switch (item.kind) {
        case "owner": {
          const previous = lastOwnerAt;
          lastOwnerAt = item.at;
          const divider = previous === null ? Date.parse(item.at) - Date.parse(earliestAt ?? item.at) > DIVIDER_GAP_MS || earliestAt === null
            : Date.parse(item.at) - Date.parse(previous) > DIVIDER_GAP_MS;
          return <Fragment key={item.key}>{divider && <TimeDivider at={item.at} />}
            <Bubble agentId={agent.id} from="owner" text={item.text} taskId={task.id} reaction={reactions.get(item.seq)?.agent}>
              {item.attachments.map(file => <Text key={file.id} style={bubbleStyles.ownerText}>{file.name} · {bytesLabel(file.bytes)}</Text>)}
              {item.text !== "" && <Text style={bubbleStyles.ownerText}>{item.text}</Text>}
            </Bubble></Fragment>;
        }
        case "agent": return <Bubble key={item.key} agentId={agent.id} from="agent" taskId={task.id} seq={item.seq} text={item.text}
          live={item.live} reaction={item.seq === null ? undefined : reactions.get(item.seq)?.owner}><Markdown text={item.text} /></Bubble>;
        case "steps": return <Steps key={item.key} lines={item.lines} />;
        case "notice":
          if (task.error && /signed out/i.test(task.error) && item.text === task.error) return null;
          return <Notice key={item.key}>{item.text}</Notice>;
        case "request": {
          if (item.request.kind === "question") return <Bubble key={item.key} agentId={agent.id} from="agent" taskId={task.id} seq={item.seq}
            text={item.request.text} reaction={reactions.get(item.seq)?.owner}><Markdown text={item.request.text} /></Bubble>;
          const open = terminal ? undefined : openRequests.find(request => request.id === item.request.id);
          return open ? <RequestCard key={item.key} request={open} agentId={agent.id} /> : <Notice key={item.key}>{askedLine(item.request)}</Notice>;
        }
        case "domain": {
          if (item.decision === null && !terminal) {
            const request: DomainRequestView = { id: item.requestId, taskId: task.id, domains: item.domains, reason: item.reason,
              createdAt: item.at, decidedAt: null, decision: null };
            return <DomainRequestCard key={item.key} request={request} agentId={agent.id} />;
          }
          return <Notice key={item.key}>{sitesLine(item.decision, listSites(item.domains))}</Notice>;
        }
      }
    })}
    {busy && !(lastItem?.kind === "agent" && lastItem.live) && <Working index={agent.index} status={workingStatus(currentSteps)} />}
    {unplacedRequests.map(request => <RequestCard key={request.id} request={request} agentId={agent.id} />)}
    {unplacedSites.map(request => <DomainRequestCard key={request.id} request={request} agentId={agent.id} />)}
    {task.result && task.result.files.length > 0 && <View style={styles.files}>
      {task.result.files.map(file => <View key={file.fileId} style={styles.file}><Text style={styles.fileName}>{file.name}</Text><Text style={styles.meta}>{bytesLabel(file.bytes)} · {file.scope}</Text></View>)}
      <OpenOnWeb agentId={agent.id} title="Open in the web app" />
    </View>}
    {task.error && (/signed out/i.test(task.error) ? agent.cliSignedIn === "yes" ? <RetryNotice agentId={agent.id} taskId={task.id} /> : <Notice>{SIGNED_OUT}</Notice>
      : !items.some(item => item.kind === "notice" && item.text === task.error) && <ErrorLine error={task.error} />)}
    <ErrorLine error={stream.error} />
    {Boolean(stream.error) && <Button title="Reconnect" kind="light" onPress={stream.reconnect} />}
  </>;
}

// The task failed because Claude was signed out, and it is signed in now: the retry instead of the old error.
function RetryNotice({ agentId, taskId }: { agentId: string; taskId: string }) {
  const { api } = useSignedIn();
  const retry = useAction(agentId, () => api.message(taskId, "Try again."));
  return <View style={styles.retry}>
    <Notice>This failed while Claude was signed out. It is signed in now.</Notice>
    <Button title="Try again" onPress={() => retry.run()} busy={retry.isPending} />
    <ErrorLine error={retry.error} />
  </View>;
}

// While the attended session is open, the sites approved only while the owner watches are reachable for the agent.
// Closing it here never asks for the AI provider permission.
function AttendedBar({ agentId }: { agentId: string }) {
  const { api } = useSignedIn();
  const close = useAction(agentId, () => api.attended(agentId, false), false);
  return <View style={styles.attended} accessibilityLiveRegion="polite">
    <Text style={[styles.meta, styles.flex]}>Attended session on: sites you allowed only while you watch are reachable.</Text>
    <Button title="Turn off" kind="light" onPress={() => close.run()} busy={close.isPending} />
    <ErrorLine error={close.error} />
  </View>;
}

// The agent's name in the navigation bar opens the iPhone's rename prompt: Save or Return saves, Cancel keeps the old
// name. A name the app or the server refuses opens the prompt again with the reason and what the owner typed.
function AgentTitle({ name, busy, onPress }: { name: string; busy: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Rename ${name}`} accessibilityState={{ busy }} disabled={busy} onPress={onPress}
    style={({ pressed }) => [styles.title, pressed && styles.titlePressed]}>
    <Text style={styles.titleText} numberOfLines={1}>{name}</Text>
    {busy ? <ActivityIndicator size="small" /> : <Text style={styles.titleEdit}>✎</Text>}
  </Pressable>;
}

export function AgentChat({ agentId }: { agentId: string }) {
  const { api, connection } = useSignedIn();
  const client = useQueryClient();
  const agent = useQuery({ queryKey: [connection.origin, "agent", agentId], queryFn: () => api.agent(agentId), refetchInterval: 5000 });
  // Renaming sends nothing to the AI provider, so it asks no permission.
  const rename = useAction(agentId, async (name: string) => {
    const updated = await api.rename(agentId, name);
    client.setQueryData([connection.origin, "agent", agentId], updated);
    client.setQueryData<AgentsResponse>([connection.origin, "agents"], list => withAgent(list, updated));
    return updated;
  }, false);
  const askName = (current: AgentSummary, typed: string, problem?: string) => Alert.prompt(`Rename ${current.name}`, problem, [
    { text: "Cancel", style: "cancel" },
    { text: "Save", isPreferred: true, onPress: (value = "") => {
      const edit = agentNameEdit(value, current.name);
      if (edit.kind === "invalid") askName(current, value, edit.message);
      else if (edit.kind === "save") rename.mutate(edit.name, { onError: error => askName(current, value, error.message) });
    } },
  ], "plain-text", typed);
  const current = agent.data;
  return <>
    <Stack.Screen options={{ title: current?.name ?? "", ...(current ? { headerTitle: () => <AgentTitle name={current.name} busy={rename.isPending} onPress={() => askName(current, current.name)} /> } : {}), headerRight: () => <Pressable accessibilityRole="button" accessibilityLabel="Computer"
      onPress={() => router.push({ pathname: "/computer/[agentId]", params: { agentId } })}><Text style={styles.headerButton}>Computer</Text></Pressable> }} />
    {agent.data ? <Chat key={`${connection.origin}|${agentId}`} agent={agent.data} /> : <View style={styles.loading}><ErrorLine error={agent.error} />{agent.isPending && <Notice>Loading…</Notice>}</View>}
  </>;
}

function Chat({ agent }: { agent: AgentSummary }) {
  const { api, connection } = useSignedIn();
  const insets = useSafeAreaInsets();
  const [selection, setSelection] = useState<string | null | undefined>(undefined);
  const tasks = useQuery({ queryKey: [connection.origin, "agent-tasks", agent.id], queryFn: () => api.tasks(agent.id), refetchInterval: 5000 });
  const list = tasks.data?.tasks ?? [];
  const selectedId = selection === undefined ? list[0]?.id ?? null : selection;
  const detail = useQuery({ queryKey: [connection.origin, "task", selectedId], queryFn: () => api.task(selectedId as string), enabled: selectedId !== null, refetchInterval: 5000 });
  const stream = useTaskStream(selectedId);
  // The task as loaded, or newer: a state event the stream delivered after the load.
  const loaded = selectedId === null ? null : detail.data ?? null;
  const current = loaded ? liveTask(loaded.task, loaded.lastSeq, stream.events) : null;
  const position = selectedId === null ? 0 : list.findIndex(task => task.id === selectedId);
  const earlier = (position >= 0 ? list.slice(position + 1) : []).slice(0, 6).reverse();
  const inbox = useQuery({ queryKey: [connection.origin, "inbox"], queryFn: api.inbox, refetchInterval: 5000 });
  const openRequests = detail.data?.openRequests.filter(request => request.answeredAt === null) ?? [];
  const openSites = inbox.data?.items.some(item => item.kind === "domain_request" && item.request.taskId === selectedId) ?? false;
  const openQuestion = openRequests.find(request => request.kind === "question") ?? openRequests[0] ?? null;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={insets.top + 44}>
    <ScrollView ref={scroll} style={styles.screen} contentContainerStyle={styles.chat} keyboardShouldPersistTaps="handled"
      onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} accessibilityLabel={`${agent.name} chat`}>
      {tasks.isPending && <Notice>Loading…</Notice>}
      <ErrorLine error={tasks.error ?? inbox.error} />
      {list.length === 0 && !tasks.isPending && !tasks.error && (agent.cliSignedIn !== "yes" ? <Notice>{SIGNED_OUT}</Notice> : <View style={styles.empty}>
        <AgentAvatar index={agent.index} size={72} /><Text style={styles.name}>{agent.name}</Text>
        <Text style={styles.intro}>Give {agent.name} a task. It works on its own computer and asks you when it needs something.</Text>
      </View>)}
      {earlier.map((task, i) => <EarlierTask key={task.id} agentId={agent.id} task={task} onOpen={() => setSelection(task.id)}
        divider={i === 0 || Date.parse(task.createdAt) - Date.parse(earlier[i - 1]?.updatedAt ?? task.createdAt) > DIVIDER_GAP_MS} />)}
      {selection === null && list.length > 0 && <Notice>New task</Notice>}
      <ErrorLine error={detail.error} />
      {selectedId && detail.isPending && <Notice>Loading…</Notice>}
      {current && <CurrentTask key={current.id} agent={agent} task={current} openRequests={openRequests} earliestAt={earlier.at(-1)?.updatedAt ?? null} stream={stream} inbox={inbox.data} />}
      {position > 0 && <Button title="Back to the latest task" kind="quiet" onPress={() => setSelection(undefined)} />}
    </ScrollView>
    {agent.computer.attendedOpen && <AttendedBar agentId={agent.id} />}
    <View style={{ paddingBottom: insets.bottom }}><Composer agent={agent} task={current} ready={!tasks.isPending && !tasks.error && (selectedId === null || current !== null)}
      openQuestion={openQuestion} waiting={openRequests.length > 0 || openSites} startNew={() => setSelection(null)} onCreated={task => setSelection(task.id)} /></View>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, chat: { padding: 16, paddingBottom: 24 }, loading: { padding: 20 },
  headerButton: { color: colors.purple, fontSize: 17, paddingVertical: 8 }, time: { color: colors.muted, textAlign: "center", fontSize: 12, marginVertical: 16 },
  steps: { marginVertical: 4 }, stepsToggle: { paddingVertical: 12, paddingHorizontal: 4 }, stepList: { paddingLeft: 12, gap: 8, borderLeftWidth: 2, borderLeftColor: colors.line, marginBottom: 10 },
  meta: { color: colors.muted, fontSize: 13 }, note: { fontStyle: "italic" }, working: { flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 12 }, flex: { flex: 1 },
  files: { gap: 10, marginVertical: 10 }, file: { backgroundColor: colors.sidebar, borderRadius: 12, padding: 14, gap: 4 }, fileName: { color: colors.text, fontSize: 16, fontWeight: "600" },
  empty: { alignItems: "center", paddingVertical: 40, gap: 12 }, name: { fontSize: 28, fontWeight: "700", color: colors.text },
  intro: { color: colors.textSoft, fontSize: 16, textAlign: "center" }, retry: { gap: 8, marginVertical: 8 },
  title: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 240, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 8 }, titlePressed: { backgroundColor: colors.sidebar },
  titleText: { flexShrink: 1, color: colors.text, fontSize: 17, fontWeight: "600" }, titleEdit: { color: colors.muted, fontSize: 15 },
  attended: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.sidebar },
});
