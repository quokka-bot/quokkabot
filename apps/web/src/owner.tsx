import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { OwnerName, type Me } from "@quokkabot/shared";
import { api } from "./api.js";
import { ErrorLine, useAction } from "./ui.js";

// The avatar's letter: the name's first character as a reader sees it (a letter with its accents, a whole emoji), in
// capitals when that stays one character ("ß" would become "SS").
export function ownerInitial(name: string): string {
  const first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)[Symbol.iterator]().next().value?.segment;
  if (first === undefined) throw new Error("ownerInitial needs a name");
  const upper = first.toUpperCase();
  return [...upper].length === [...first].length ? upper : first;
}

// What the owner's round avatar holds. Before the owner gives a name: a person outline, which stands for the account
// without a made-up letter (a "?" would read as an error). While /api/me loads: nothing.
export function OwnerAvatarContent({ name }: { name: string | undefined }) {
  if (name === undefined) return null;
  if (name === "") return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" data-testid="owner-avatar-no-name"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7.5 8-7.5s8 3.1 8 7.5z" /></svg>;
  return <>{ownerInitial(name)}</>;
}

// Saves the owner's name and puts the server's answer in the ["me"] cache, so the avatar changes at once.
function useSaveOwnerName() {
  const client = useQueryClient();
  return useAction(async (name: string) => {
    const me = await api.setOwnerName(name);
    await client.cancelQueries({ queryKey: ["me"] });
    client.setQueryData<Me>(["me"], me);
    return me;
  });
}

// The name as the server will store it, or the reason it cannot.
function checkName(value: string): { name: string; problem: null } | { name: null; problem: string } {
  const parsed = OwnerName.safeParse(value);
  return parsed.success ? { name: parsed.data, problem: null } : { name: null, problem: parsed.error.issues[0]?.message ?? "Enter your name." };
}

// The setup page's last step, after the passkey.
export function SetupOwnerName({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveOwnerName();
  return <form className="auth-form" onSubmit={event => {
    event.preventDefault();
    const checked = checkName(value);
    setProblem(checked.problem);
    if (checked.name !== null) save.mutate(checked.name, { onSuccess: onSaved });
  }}>
    <label>Your name<input value={value} onChange={event => setValue(event.target.value)} autoComplete="name" autoFocus required /></label>
    {problem && <p className="error" role="alert">{problem}</p>}
    <button className="pill dark wide" disabled={save.isPending}>{save.isPending ? "Saving…" : "Continue"}</button>
    <ErrorLine error={save.error} />
  </form>;
}

export function OwnerNameSetting() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  return me.data ? <OwnerNameForm initial={me.data.ownerName} /> : <section className="card" aria-label="Your name"><h2>Your name</h2><ErrorLine error={me.error} /></section>;
}

function OwnerNameForm({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSaveOwnerName();
  return <form className="card settings-form" aria-label="Your name" onSubmit={event => {
    event.preventDefault();
    const checked = checkName(value);
    setProblem(checked.problem);
    if (checked.name !== null) save.mutate(checked.name, { onSuccess: me => setValue(me.ownerName) });
  }}>
    <h2>Your name</h2>
    <p className="meta">It shows on your avatar in the Quokka Bot apps.</p>
    <input aria-label="Your name" value={value} onChange={event => { setValue(event.target.value); save.reset(); }} autoComplete="name" required />
    {problem && <p className="error" role="alert">{problem}</p>}
    <button className="primary" disabled={save.isPending}>Save name</button>
    <ErrorLine error={save.error} />{save.isSuccess && <p role="status">Name saved.</p>}
  </form>;
}
