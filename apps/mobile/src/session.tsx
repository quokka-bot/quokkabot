import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetch } from "expo/fetch";
import { useQueryClient } from "@tanstack/react-query";
import { type Api, createApi, type Fetch } from "./api";
import { clearConnection, type Connection, forgetIfReinstalled, loadConnection, saveConnection } from "./connection";

export const appFetch: Fetch = (url, init) => fetch(url, init);

type SessionState =
  | { state: "loading" }
  | { state: "failed"; error: Error }
  | { state: "signed-out"; reason: string | null }
  | { state: "signed-in"; connection: Connection; api: Api };

interface SessionContext {
  session: SessionState;
  signIn(connection: Connection): Promise<void>;
  // Forgets the connection here. `reason` is shown on the sign-in screen (the server signed this phone out).
  signOut(reason?: string): Promise<void>;
}

const Context = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [failure, setFailure] = useState<Error | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    void forgetIfReinstalled().then(loadConnection).then(setConnection, (error: unknown) => setFailure(error instanceof Error ? error : new Error(String(error))));
  }, []);
  const signOut = useCallback(async (why?: string) => {
    await clearConnection();
    client.clear();
    setReason(why ?? null);
    setConnection(null);
  }, [client]);
  const signIn = useCallback(async (next: Connection) => {
    await saveConnection(next);
    client.clear();
    setReason(null);
    setConnection(next);
  }, [client]);
  const api = useMemo(() => connection
    ? createApi(appFetch, connection.origin, connection.token, () => { void signOut("This phone was signed out. Sign in again."); })
    : null, [connection, signOut]);
  const session: SessionState = failure ? { state: "failed", error: failure }
    : connection === undefined ? { state: "loading" }
    : connection === null || api === null ? { state: "signed-out", reason }
    : { state: "signed-in", connection, api };
  return <Context.Provider value={{ session, signIn, signOut }}>{children}</Context.Provider>;
}

export function useSession(): SessionContext {
  const context = useContext(Context);
  if (!context) throw new Error("useSession outside SessionProvider");
  return context;
}

// The signed-in API and connection, for screens that only exist while signed in.
export function useSignedIn(): { api: Api; connection: Connection } {
  const { session } = useSession();
  if (session.state !== "signed-in") throw new Error("This screen needs a signed-in phone");
  return { api: session.api, connection: session.connection };
}
