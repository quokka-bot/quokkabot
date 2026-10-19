import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router";
import { UNAUTHORIZED_EVENT } from "./api.js";
import { Setup, SignIn } from "./auth.js";
import { OwnerSettings } from "./settings.js";
import { DesktopLink } from "./link.js";
import "./desktop.js";
import { AgentScreen, FirstAgent, GlobalSettings, OwnerLayout, TaskRedirect } from "./shell.js";

export function SessionRouting() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const location = useLocation();
  useEffect(() => {
    const signedOut = () => {
      client.clear();
      void navigate(location.pathname === "/link" ? "/signin?returnTo=%2Flink" : "/signin", { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  }, [client, navigate, location.pathname]);
  useEffect(() => window.quokkabotDesktop?.onNavigate(route => {
    const url = new URL(route, window.location.origin);
    if (!route.startsWith("/") || url.origin !== window.location.origin) throw new Error("Desktop navigation must use an app route");
    void navigate(`${url.pathname}${url.search}`);
  }), [navigate]);
  return null;
}

export function App() {
  return <><SessionRouting /><Routes>
    <Route path="/setup" element={<main className="auth-page"><Setup /></main>} />
    <Route path="/signin" element={<main className="auth-page"><SignIn /></main>} />
    <Route path="/link" element={<main className="auth-page"><DesktopLink /></main>} />
    <Route element={<OwnerLayout />}>
      <Route index element={<FirstAgent />} />
      <Route path="settings" element={<GlobalSettings><OwnerSettings /></GlobalSettings>} />
      <Route path="agents/:agentId" element={<AgentScreen />} />
      <Route path="agents/:agentId/:section" element={<AgentScreen />} />
      <Route path="tasks/:taskId" element={<TaskRedirect />} />
      <Route path="*" element={<p className="notice info">Page not found. <Link to="/">Go home</Link></p>} />
    </Route>
  </Routes></>;
}
