import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { StyleSheet, Switch, Text, View } from "react-native";
import type { DomainDecision, DomainRequestView, LoginView, OwnerRequest } from "@quokkabot/shared";
import { askedLine, listSites, loginRequestOptions, sitesLine } from "@quokkabot/client";
import { useAction } from "../chat/use-action";
import { useSignedIn } from "../session";
import { Button, ErrorLine, Notice } from "../ui/kit";
import { colors } from "../ui/theme";
import { LoginForm } from "./login-form";

function Card({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return <View style={styles.card}><Text style={styles.title}>{title}</Text>
    {detail && <Text style={styles.detail}>{detail}</Text>}{children}</View>;
}

export function OpenOnWeb({ agentId, title = "Open this on the web" }: { agentId: string; title?: string }) {
  const { connection } = useSignedIn();
  const open = useAction(agentId, () => WebBrowser.openBrowserAsync(`${connection.origin}/agents/${encodeURIComponent(agentId)}`), false);
  return <View><Button title={title} kind="light" onPress={() => open.run()} busy={open.isPending} /><ErrorLine error={open.error} /></View>;
}

export function RequestCard({ request, agentId }: { request: OwnerRequest; agentId: string }) {
  const [resolved, setResolved] = useState(false);
  if (resolved || request.answeredAt !== null) return <Notice>{askedLine(request)}</Notice>;
  switch (request.kind) {
    case "question": return null;
    case "login": return <LoginRequestCard request={request} agentId={agentId} onResolved={() => setResolved(true)} />;
    case "connect": return request.connector === null || request.connector === "gmail" ? <ConnectCard request={request} agentId={agentId} /> : <OpenOnWeb agentId={agentId} />;
    case "takeover": return <TakeoverCard request={request} agentId={agentId} onResolved={() => setResolved(true)} />;
    default: return <OpenOnWeb agentId={agentId} />;
  }
}

function ConnectCard({ request, agentId }: { request: OwnerRequest; agentId: string }) {
  return <Card title="Connect Gmail" detail="Approve on Google's page, no password here">
    <Text style={styles.detail}>{request.text}</Text><OpenOnWeb agentId={agentId} title="Connect in the web app" />
  </Card>;
}

function TakeoverCard({ request, agentId, onResolved }: { request: OwnerRequest; agentId: string; onResolved: () => void }) {
  const { api } = useSignedIn();
  const take = useAction(agentId, async () => {
    await api.takeover(agentId, "take");
    router.push({ pathname: "/computer/[agentId]", params: { agentId } });
  }, false);
  const done = useAction(agentId, async () => { await api.takeoverDone(request.taskId); onResolved(); });
  return <Card title="Take over the browser" detail={request.whatToDo ?? request.text}>
    <Button title="Open" onPress={() => take.run()} busy={take.isPending} />
    <Button title="I'm done, continue" kind="quiet" onPress={() => done.run()} busy={done.isPending} />
    <ErrorLine error={take.error ?? done.error} />
  </Card>;
}

function LoginRequestCard({ request, agentId, onResolved }: { request: OwnerRequest; agentId: string; onResolved: () => void }) {
  const { api, connection } = useSignedIn();
  const [open, setOpen] = useState(false);
  const logins = useQuery({ queryKey: [connection.origin, "logins", agentId], queryFn: () => api.logins(agentId), enabled: request.loginId !== null });
  const existing = request.loginId === null ? undefined : logins.data?.logins.find(login => login.id === request.loginId);
  const myself = useAction(agentId, async () => {
    await api.signInMyself(request.id);
    await api.takeover(agentId, "take");
    router.push({ pathname: "/computer/[agentId]", params: { agentId } });
  });
  const { title, otherSite, google } = loginRequestOptions(request, existing);
  if (google) return <ConnectCard request={request} agentId={agentId} />;
  if (otherSite && existing && request.site) return <AllowLoginCard agentId={agentId} login={existing} site={request.site} onResolved={onResolved}
    signInMyself={() => myself.run()} signingIn={myself.isPending} signInError={myself.error} />;
  return <Card title={title} detail={request.loginId === null ? "Secure form" : `${request.site ?? "The site"} rejected it`}>
    <Text style={styles.detail}>{request.text}</Text>
    {!open && <Button title="Open" onPress={() => setOpen(true)} />}
    {open && (request.loginId !== null
      ? existing ? <LoginForm agentId={agentId} login={existing} onSaved={onResolved} onCancel={() => setOpen(false)} />
        : logins.isPending ? <Notice>Loading the saved login…</Notice>
          : <ErrorLine error={logins.error ?? new Error("The saved login was deleted. Add it again in Logins.")} />
      : request.site ? <LoginForm agentId={agentId} initialSite={request.site} initialName={request.loginName ?? request.site} onSaved={onResolved} onCancel={() => setOpen(false)} />
        : <ErrorLine error={new Error("Login request is missing its site")} />)}
    <Button title="Sign in myself instead" kind="quiet" onPress={() => myself.run()} busy={myself.isPending} />
    <ErrorLine error={myself.error} />
  </Card>;
}

function AllowLoginCard({ agentId, login, site, onResolved, signInMyself, signingIn, signInError }: {
  agentId: string; login: LoginView; site: string; onResolved: () => void; signInMyself: () => void; signingIn: boolean; signInError: Error | null;
}) {
  const { api } = useSignedIn();
  const allow = useAction(agentId, async () => { await api.updateLogin(login.id, { sites: [...login.sites, site] }); onResolved(); });
  return <Card title={`Use the ${login.name} login on ${site}`} detail={`Saved for ${listSites(login.sites)}`}>
    <Button title="Allow" onPress={() => allow.run()} busy={allow.isPending} />
    <Button title="Sign in myself instead" kind="quiet" onPress={signInMyself} busy={signingIn} />
    <ErrorLine error={allow.error ?? signInError} />
  </Card>;
}

export function DomainRequestCard({ request, agentId }: { request: DomainRequestView; agentId: string }) {
  const { api } = useSignedIn();
  const [attended, setAttended] = useState(false);
  const [resolved, setResolved] = useState<DomainDecision | null>(null);
  const decide = useAction(agentId, async (decision: "allow_task" | "allow_always" | "refuse") => {
    await api.decideDomain(request.id, decision, attended);
    setResolved(decision);
  });
  if (resolved || request.decidedAt !== null) return <Notice>{sitesLine(resolved ?? request.decision, listSites(request.domains))}</Notice>;
  return <Card title={`Allow ${listSites(request.domains)}`} detail={request.reason}>
    <View style={styles.switchRow}><Text style={styles.switchText}>Only while I watch</Text>
      <Switch accessibilityLabel="Only while I watch" value={attended} onValueChange={setAttended} disabled={decide.isPending} /></View>
    <View style={styles.actions}>
      <Button title="Allow for this task" onPress={() => decide.run("allow_task")} disabled={request.taskId === null || decide.isPending} />
      <Button title="Always allow" kind="light" onPress={() => decide.run("allow_always")} disabled={decide.isPending} />
      <Button title="Refuse" kind="light" onPress={() => decide.run("refuse")} disabled={decide.isPending} />
    </View><ErrorLine error={decide.error} />
  </Card>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 18, padding: 16, gap: 12, marginVertical: 6 },
  title: { fontSize: 17, fontWeight: "600", color: colors.text }, detail: { fontSize: 15, color: colors.textSoft },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchText: { flex: 1, color: colors.text, fontSize: 15 },
});
