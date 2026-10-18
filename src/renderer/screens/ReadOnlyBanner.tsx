import { api } from '../api';
import { Button, useAction, useLoad } from '../ui';

/**
 * Alleen in de versie uit de Microsoft Store, als het overzetten van de gegevens niet lukte en je koos
 * voor "Alleen bekijken": je ziet je administratie, maar kunt niets wijzigen. "Opnieuw proberen" start de
 * app opnieuw; die probeert het overzetten dan nog eens en laat je anders zelf een map kiezen.
 */
export function ReadOnlyBanner() {
  const { run, busy } = useAction();
  const distribution = useLoad(() => api.app.distribution());
  if (!distribution.data?.readOnly) return null;
  return (
    <div className="notice warn row between" role="status" style={{ margin: '0 0 16px' }}>
      <span>
        <strong>Je kunt je administratie nu alleen bekijken.</strong> Je gegevens zijn nog niet overgezet naar de nieuwe map; tot dat gelukt is kun je niets wijzigen.
      </span>
      <Button small kind="primary" disabled={busy} onClick={() => void run(async () => { await api.app.retryDataMove(); return true; })}>Opnieuw proberen</Button>
    </div>
  );
}
