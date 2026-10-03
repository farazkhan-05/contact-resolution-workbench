import { useLayoutEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Job } from '../../types';

// Every open/tracking/check generation owns its requests and timer.
// A failed read pauses polling; it never changes the durable outcome.
export function useJobStatus(initial: Job | null, enabled: boolean) {
  const [job, setJob] = useState(initial);
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [revision, setRevision] = useState(0);
  const checkedRevision = useRef(0);
  const generation = useRef(0);
  useLayoutEffect(() => {
    setJob(initial);
  }, [initial]);
  useLayoutEffect(() => {
    const owner = ++generation.current;
    const manualCheck = checkedRevision.current !== revision;
    checkedRevision.current = revision;
    let timer: number | undefined;
    const current = () => generation.current === owner;
    setError(false);
    setChecking(false);
    const check = async () => {
      if (!initial || !current()) return;
      setChecking(true);
      try {
        const next = await api.getJob(initial.id);
        if (!current()) return;
        if (next.id !== initial.id || next.workspace_id !== initial.workspace_id) throw Error('Unexpected Job');
        setJob(next);
        setError(false);
        if (next.status === 'PENDING' || next.status === 'RUNNING') {
          timer = window.setTimeout(() => void check(), 1800);
        }
      } catch {
        if (current()) setError(true);
      } finally {
        if (current()) setChecking(false);
      }
    };
    if (enabled && initial && (manualCheck || initial.status === 'PENDING' || initial.status === 'RUNNING')) {
      void check();
    }
    return () => { generation.current += 1; window.clearTimeout(timer); };
  }, [initial, enabled, revision]);
  return { job, error, checking, checkAgain: () => setRevision(value => value + 1) };
}
