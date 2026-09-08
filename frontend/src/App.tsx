import { useEffect, useState } from 'react';
import { apiMe, getToken, setToken } from './api';
import type { Session } from './types';
import { AuthScreen } from './components/AuthScreen';
import { RequesterView } from './components/RequesterView';
import { AgentView } from './components/AgentView';
import { AdminView } from './components/AdminView';
import { Spinner } from './components/ui';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);

  // Restore a previously stored token on refresh (validated via /auth/me).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await apiMe();
        if (!cancelled) setSession({ accessToken: getToken() ?? '', user: me });
      } catch {
        setToken(null); // stale/invalid token
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const authed = (s: Session) => {
    setToken(s.accessToken);
    setSession(s);
  };

  const logout = () => {
    setToken(null);
    setSession(null);
  };

  if (booting) return <Spinner />;

  if (!session) return <AuthScreen onAuthed={authed} />;

  const { user } = session;
  const roleLabel =
    user.role === 'Admin'
      ? 'Admin'
      : user.role === 'Employee'
        ? 'Requester'
        : `${user.role.replace('_Agent', '')} Agent`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Eurisko Hub</div>
        <div className="who">
          <span className="role-chip">{roleLabel}</span>
          <span className="muted small">
            {user.name} · {user.email}
          </span>
          <button className="btn btn-ghost" onClick={logout}>
            Switch account
          </button>
        </div>
      </header>
      <main className="content">
        {user.role === 'Admin' ? (
          <AdminView />
        ) : user.role === 'Employee' ? (
          <RequesterView />
        ) : (
          <AgentView user={user} />
        )}
      </main>
    </div>
  );
}
