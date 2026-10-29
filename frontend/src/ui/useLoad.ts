import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/** Carrega um endpoint e expõe recarregar; erros viram mensagem para a tela. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    if (!path) return;
    setError('');
    api<T>(path).then(setData).catch(e => setError(e.message));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}
