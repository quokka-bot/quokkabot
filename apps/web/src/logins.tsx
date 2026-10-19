import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SaveLoginRequest, siteLabel, UpdateLoginRequest, type LoginView } from "@quokkabot/shared";
import { loginSites, validateTotp } from "@quokkabot/client";
import { api } from "./api.js";
import { dateLabel, ErrorLine, useAction } from "./ui.js";

export function LoginForm({ agentId, login, initialSite = "", initialName = "", onSaved, onCancel }: {
  agentId: string; login?: LoginView; initialSite?: string; initialName?: string; onSaved: () => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(login?.name ?? initialName);
  const [sites, setSites] = useState(login?.sites.map(siteLabel).join(", ") ?? initialSite);
  const [username, setUsername] = useState(login?.username ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState("");
  const [removeTotp, setRemoveTotp] = useState(false);
  const save = useAction(async () => {
    const patterns = loginSites(sites);
    const common = { name: name.trim(), sites: patterns, username };
    const twoFactor = !removeTotp && totp.trim() ? validateTotp(totp) : undefined;
    if (login) {
      const input = UpdateLoginRequest.parse({ ...common, ...(password ? { password } : {}), ...(removeTotp ? { totp: null } : twoFactor ? { totp: twoFactor } : {}) });
      await api.updateLogin(login.id, input);
    } else {
      const input = SaveLoginRequest.parse({ ...common, password, ...(twoFactor ? { totp: twoFactor } : {}) });
      await api.saveLogin(agentId, input);
    }
    setPassword(""); setTotp(""); setShowPassword(false);
    onSaved();
  });
  // From a request card the site and name are known: ask only for what the owner has to type.
  const compact = !login && initialSite !== "";
  const [details, setDetails] = useState(!compact);
  const [withTotp, setWithTotp] = useState(!compact);
  return <form className="login-form settings-form" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    {details
      ? <>
        <label>Name<input value={name} onChange={event => setName(event.target.value)} required maxLength={80} /></label>
        <label>Sites<input value={sites} onChange={event => setSites(event.target.value)} placeholder="example.com" autoCapitalize="none" autoCorrect="off" required /></label>
      </>
      : <p className="meta">For {sites} · <button type="button" className="link-button" onClick={() => setDetails(true)}>change</button></p>}
    <label>{compact ? "Email or username" : "Username"}<input value={username} onChange={event => setUsername(event.target.value)} required maxLength={320} autoCapitalize="none" autoCorrect="off" autoComplete="off" autoFocus={compact} /></label>
    <label>{login ? "New password (leave empty to keep saved password)" : "Password"}<input type={showPassword ? "text" : "password"} value={password} onChange={event => setPassword(event.target.value)} required={!login} maxLength={500} autoComplete="new-password" /></label>
    <button type="button" className="link-button" aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? "Hide password" : "Show password"}</button>
    {withTotp
      ? <>
        <label>2FA secret (optional)<input type="password" value={totp} onChange={event => setTotp(event.target.value)} disabled={removeTotp} maxLength={1000} autoComplete="off" autoCapitalize="none" autoCorrect="off" /></label>
        <p className="meta">Find the base32 secret or otpauth:// URI on the site’s 2FA setup page, usually under “Can’t scan the QR code?”.{login?.hasTotp && " Leave empty to keep saved 2FA."}</p>
      </>
      : <p className="meta"><button type="button" className="link-button" onClick={() => setWithTotp(true)}>Add an authenticator code</button></p>}
    {login?.hasTotp && <label className="switch"><input type="checkbox" checked={removeTotp} onChange={event => setRemoveTotp(event.target.checked)} />Remove saved 2FA</label>}
    <div className="actions wrap"><button className="primary" disabled={save.isPending}>{save.isPending ? "Saving…" : "Save login"}</button>{onCancel && <button type="button" disabled={save.isPending} onClick={onCancel}>Cancel</button>}</div>
    <ErrorLine error={save.error} />
  </form>;
}

function LoginCard({ login }: { login: LoginView }) {
  const [editing, setEditing] = useState(false);
  const remove = useAction(async () => { await api.deleteLogin(login.id); });
  return <article className="card">
    <h3>{login.name}</h3><p className="plain">{login.sites.map(siteLabel).join(", ")}</p><p className="plain">Username: {login.username}</p>
    <p>Password: {login.passwordLength} characters · 2FA {login.hasTotp ? "on" : "off"}</p><p className="meta">Last used: {login.lastUsedAt ? dateLabel(login.lastUsedAt) : "Never"}</p>
    {editing ? <LoginForm agentId={login.agentId} login={login} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} /> : <div className="actions wrap">
      <button disabled={remove.isPending} onClick={() => setEditing(true)}>Edit {login.name}</button>
      <button disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete login “${login.name}”?`)) remove.mutate(); }}>Delete {login.name}</button>
    </div>}<ErrorLine error={remove.error} />
  </article>;
}

export function Logins({ agentId }: { agentId: string }) {
  const [adding, setAdding] = useState(false);
  const logins = useQuery({ queryKey: ["logins", agentId], queryFn: () => api.logins(agentId) });
  return <>
    <div className="section-heading"><h2>Logins</h2><button onClick={() => setAdding(true)} disabled={adding}>Add login</button></div>
    {adding && <section className="card"><h3>Add login</h3><LoginForm agentId={agentId} onSaved={() => setAdding(false)} onCancel={() => setAdding(false)} /></section>}
    <ErrorLine error={logins.error} />{logins.isPending && <p role="status">Loading logins…</p>}
    {logins.data?.logins.length === 0 && <p className="empty">No saved logins.</p>}
    {logins.data?.logins.map(login => <LoginCard key={login.id} login={login} />)}
  </>;
}
